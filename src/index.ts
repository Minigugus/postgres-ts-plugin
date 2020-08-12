import type tss from 'typescript/lib/tsserverlibrary';
import { resolve } from 'path';

const PKG_NAME = 'postgres';

const postgresDefinitionPath = resolve(require.resolve(PKG_NAME, { paths: [process.cwd()] }), '../..', 'types/index.d.ts');

let postgres: typeof import('postgres') = null!;
try {
  postgres = require(PKG_NAME);
} catch { }

type SqlTag = import('postgres').Sql<{
  bigint: (number: BigInt) => string;
}>;

interface IRequestCache {
  results: ISQLResult | null;
  updateTimeout: any;
}

interface IFileCache {
  fileName: string;
  lastSnapshot: tss.IScriptSnapshot | undefined;
  lastDiagnostics: ts.Diagnostic[];
  requestsCache: Map<string, IRequestCache>;
}

export default (({ typescript: ts }) => {
  let sqlTag: SqlTag | Error | null = null;
  if (!postgres)
    sqlTag = new Error(`Package "${PKG_NAME}" not found when initializing the plugin`);
  return {
    onConfigurationChanged() {
      sqlTag = null;
    },
    create(info) {
      const { languageService: tsLS } = info;
      const throttle = isNaN(+info.config.throttle) ? 1000 : +info.config.throttle;
      info.project.projectService.logger.info('postgres-ts-plugin: Plugin initialized (throttle ' + throttle + ')');
      let postgresTypeSymbol: ts.Symbol | null = null;
      let sqlTypeSymbol: ts.Symbol | null = null;
      let transactionSqlSymbol: ts.Symbol | null = null;
      let diagnosticsPerRequestsPerFile = new Map<string, Map<string, IRequestCache>>();
      function getSQLDiagnostics(file: IFileCache, program: tss.Program, sourceFile: tss.SourceFile, diagnostics: ts.Diagnostic[]) {
        const fileName = file.fileName;
        const oldRequestsCache = diagnosticsPerRequestsPerFile.get(fileName) || new Map();
        const newRequestsCache = new Map<string, IRequestCache>();
        diagnosticsPerRequestsPerFile.set(fileName, newRequestsCache);
        const typeChecker = program.getTypeChecker();
        if (!sqlTypeSymbol) {
          const definitionSourceFile = program.getSourceFile(postgresDefinitionPath);
          if (definitionSourceFile) {
            definitionSourceFile.forEachChild(child => {
              if (ts.isFunctionDeclaration(child) && child.name && child.name.text === 'postgres') {
                postgresTypeSymbol = typeChecker.getTypeAtLocation(child.name).symbol;
                if (typeof sqlTag !== 'function') {
                  const requiredOptions = { types: { bigint: postgres.BigInt } };
                  const tag = postgres(Object.assign({}, info.config.options || {}, requiredOptions) as typeof requiredOptions);
                  tag`SELECT`
                    .then(() => { sqlTag = tag })
                    .catch(err => {
                      sqlTag = err;
                      info.project.refreshDiagnostics();
                    })
                    .then(() => {
                      cachePerFile.clear();
                    });
                }
              } else if (ts.isModuleDeclaration(child))
                child.forEachChild(function visit(child) {
                  if (ts.isInterfaceDeclaration(child)) {
                    switch (child.name.text) {
                      case 'Sql':
                        const sqlInterfaceType = typeChecker.getTypeAtLocation(child.name);
                        sqlTypeSymbol = sqlInterfaceType.symbol;
                        break;
                      case 'TransactionSql':
                        const transactionSqlInterfaceType = typeChecker.getTypeAtLocation(child.name);
                        transactionSqlSymbol = transactionSqlInterfaceType.symbol;
                        break;
                    }
                  } else if (!sqlTypeSymbol)
                    child.forEachChild(visit);
                });
            });
          }
        }
        sourceFile.forEachChild(function visit(child) {
          if (typeof sqlTag === 'function') {
            child.forEachChild(function visitExpression(child) {
              if (sqlTypeSymbol && ts.isTaggedTemplateExpression(child)) {
                const sqlType = typeChecker.getTypeAtLocation(child.tag);
                const templateTagSymbol = sqlType.symbol;
                if (templateTagSymbol === sqlTypeSymbol || templateTagSymbol === transactionSqlSymbol) {
                  let sql: string;
                  let parameters: ts.Expression[] = [];
                  if (ts.isNoSubstitutionTemplateLiteral(child.template))
                    sql = child.template.text;
                  else {
                    sql = child.template.head.text;
                    child.template.templateSpans.forEach((span, i) => {
                      sql += `$${i + 1}${span.literal.text}`;
                      parameters.push(span.expression);
                    });
                  }
                  sql = sql.trim();
                  info.project.projectService.logger.info(`postgres-ts-plugin: ${fileName}@${child.getStart()}: ${sql} (${parameters.length} parameters)`);
                  const requestHash = `${tsLS.toLineColumnOffset && tsLS.toLineColumnOffset(fileName, child.getStart()).line}:${child.getText()}`;
                  if (oldRequestsCache.has(requestHash)) {
                    const cache = oldRequestsCache.get(requestHash)!;
                    info.project.projectService.logger.info(`postgres-ts-plugin: ${fileName}@${child.getStart()}: using cache`);
                    oldRequestsCache.delete(requestHash);
                    newRequestsCache.set(requestHash, cache);
                    if (cache.results)
                      diagnostics.splice(diagnostics.length, 0, ...formatResults(ts, sourceFile, child, sql, parameters, cache.results));
                  } else {
                    info.project.projectService.logger.info(`postgres-ts-plugin: ${fileName}@${child.getStart()}: added to cache`);
                    const cache: IRequestCache = {
                      results: null,
                      updateTimeout: info.serverHost.setTimeout(() => {
                        info.project.projectService.logger.info(`postgres-ts-plugin: ${fileName}@${child.getStart()}: requesting diagnostic from server`);
                        onSQLQuery(ts, typeChecker, sqlTag as SqlTag, sql, parameters)
                          .then(results => {
                            info.project.projectService.logger.info(`postgres-ts-plugin: ${fileName}@${child.getStart()}: got diagnostics from server`);
                            cache.results = results;
                            cachePerFile.get(fileName)!.lastDiagnostics.splice(diagnostics.length, 0, ...formatResults(ts, sourceFile, child, sql, parameters, cache.results));
                            info.project.refreshDiagnostics();
                          })
                      }, throttle)
                    };
                    newRequestsCache.set(requestHash, cache);
                  }
                }
              }
              child.forEachChild(visitExpression);
            });
          } else if (sqlTag && typeof sqlTag !== 'function') {
            if (ts.isImportDeclaration(child)) { // ESM
              const importDeclaration = child.moduleSpecifier;
              if (!ts.isStringLiteral(importDeclaration))
                return; // If this is not a StringLiteral it will be a grammar error.
              if (importDeclaration.text === PKG_NAME) {
                const importClause = child.importClause;
                if (importClause) {
                  diagnostics.push({
                    category: ts.DiagnosticCategory.Warning,
                    code: 5432,
                    file: sourceFile,
                    source: 'postgres',
                    length: importDeclaration.getEnd() - importDeclaration.getStart(),
                    start: importDeclaration.getStart(),
                    messageText: {
                      code: 5432,
                      category: ts.DiagnosticCategory.Warning,
                      messageText: (postgres)
                        ? 'Connection to SQL server failed - SQL validation will not work'
                        : 'Plugin initialization failed - SQL validation will not work',
                      next: [{
                        code: 5432,
                        category: ts.DiagnosticCategory.Warning,
                        messageText: 'Internal error: ' + sqlTag.message
                      }]
                    }
                  });
                }
              }
            } else {
              child.forEachChild(function visit(child) {
                if ( // CommonJS
                  ts.isCallExpression(child) &&
                  child.arguments.length === 1 &&
                  ts.isIdentifier(child.expression) &&
                  child.expression.text === 'require' &&
                  ts.isStringLiteral(child.arguments[0]) &&
                  (child.arguments[0] as tss.StringLiteral).text === PKG_NAME
                ) {
                  info.project.projectService.logger.info("postgres-ts-plugin: require found");
                  diagnostics.push({
                    category: ts.DiagnosticCategory.Warning,
                    code: 5432,
                    file: sourceFile,
                    source: 'postgres',
                    length: child.arguments[0].getEnd() - child.arguments[0].getStart(),
                    start: child.arguments[0].getStart(),
                    messageText: {
                      code: 5432,
                      category: ts.DiagnosticCategory.Warning,
                      messageText: (postgres)
                        ? 'Connection to SQL server failed - SQL validation will not work'
                        : 'Plugin initialization failed - SQL validation will not work',
                      next: [{
                        code: 5432,
                        category: ts.DiagnosticCategory.Warning,
                        messageText: 'Internal error: ' + (sqlTag as Error).message
                      }]
                    }
                  });
                }
                child.forEachChild(visit);
              })
            }
          }
        });
        for (const cache of oldRequestsCache.values())
          info.serverHost.clearTimeout(cache.updateTimeout);
        return diagnostics;
      }
      const cachePerFile = new Map<string, IFileCache>();
      return {
        ...tsLS,
        getSuggestionDiagnostics(fileName) {
          const diagnostics: ts.Diagnostic[] = tsLS.getSuggestionDiagnostics(fileName);
          const program = this.getProgram();
          if (program) {
            const sourceFile = program.getSourceFile(fileName);
            if (!cachePerFile.has(fileName))
              cachePerFile.set(fileName, { fileName, lastDiagnostics: [], lastSnapshot: undefined, requestsCache: new Map() });
            const fileCache = cachePerFile.get(fileName)!;
            const snapshot = info.languageServiceHost.getScriptSnapshot(fileName);
            const changes = fileCache.lastSnapshot && snapshot && snapshot.getChangeRange(fileCache.lastSnapshot);
            fileCache.lastSnapshot = snapshot;
            if (changes && !changes.newLength && !changes.span.start && !changes.span.length) {
              info.project.projectService.logger.info('postgres-ts-plugin: ' + fileName + ': no changes - using cache (' + fileCache.lastDiagnostics.length + ' diagnostics)');
              return fileCache.lastDiagnostics;
            }
            if (changes)
              info.project.projectService.logger.info('postgres-ts-plugin: ' + fileName + ': changes from ' + changes.span.start + ' to ' + (changes.span.start + changes.span.length) + ' (new length ' + changes.newLength + ')');
            else
              info.project.projectService.logger.info('postgres-ts-plugin: ' + fileName + ': no previous snapshot for this file yet');
            if (sourceFile) {
              fileCache.lastDiagnostics = getSQLDiagnostics(fileCache, program, sourceFile, []);
              info.project.projectService.logger.info('postgres-ts-plugin: ' + fileName + ': found ' + fileCache.lastDiagnostics.length + ' diagnostics');
              return diagnostics.concat(fileCache.lastDiagnostics);
            }
          }
          return diagnostics;
        }
      };
    }
  };
}) as tss.server.PluginModuleFactory

interface ISQLResult {
  ok?: true;
  message: string | tss.DiagnosticMessageChain | null;
  parameterNo: number | null;
}

async function onSQLQuery(
  tsModule: typeof tss,
  typeChecker: tss.TypeChecker,
  sql: SqlTag,
  query: string,
  parameters: tss.Expression[]
): Promise<ISQLResult> {
  try {
    const result = await sql.unsafe<{ "QUERY PLAN": string }>('EXPLAIN ' + query, parameters.map(x => {
      const type = typeChecker.getTypeAtLocation(x);
      if (type.isLiteral())
        return typeof type.value === 'object' ? sql.types.bigint(BigInt(type.value) * (type.value.negative ? -1n : 1n)) : type.value;
      if (type.symbol && type.symbol.name === 'string')
        return '[PARAMETER]';
      return null;
    }));
    return {
      ok: true,
      message: result.map(({ "QUERY PLAN": plan }) => plan).join('\n'),
      parameterNo: null
    };
  } catch (err) {
    if (err instanceof sql.PostgresError) {
      let parameterNo: number | null = null;
      return {
        message: {
          category: err.severity === 'ERROR' ? tsModule.DiagnosticCategory.Error : tsModule.DiagnosticCategory.Warning,
          code: 5432,
          messageText: `SQL error: ${err.message.replace(/"\$(\d+)"/, (substr, id) => {
            parameterNo = +id - 1;
            const param = parameters[parameterNo];
            if (param)
              return `"${param.getFullText()}"`;
            return substr;
          })}`,
          next: err.hint ? [{
            code: 5432,
            category: tsModule.DiagnosticCategory.Suggestion,
            messageText: err.hint
          }] : undefined
        },
        parameterNo
      };
    }
    return {
      message: `SQL validation failed: ${err && (err.message || err)}`,
      parameterNo: null
    };
  }
}

function formatResults(
  tsModule: typeof tss,
  sourceFile: tss.SourceFile,
  taggedTemplate: tss.TaggedTemplateExpression,
  query: string,
  parameters: tss.Expression[],
  results: ISQLResult
): tss.Diagnostic[] {
  if (results.ok)
    return [{
      category: tsModule.DiagnosticCategory.Suggestion,
      code: 5432,
      file: sourceFile,
      length: taggedTemplate.end - taggedTemplate.pos,
      start: taggedTemplate.getStart(),
      source: 'postgres',
      messageText: results.message || `SQL query detected: ${query} | ${parameters.length} parameter(s)`
    }];
  let at = (results.parameterNo !== null && parameters[results.parameterNo]) || taggedTemplate;
  const realStart = (tsModule.isTaggedTemplateExpression(at) ? at.template.getStart() : at.getStart()) + 1;
  return [{
    category: tsModule.DiagnosticCategory.Warning,
    code: 5432,
    file: sourceFile,
    length: at.getEnd() - realStart - 1,
    start: realStart,
    source: 'postgres',
    messageText: results.message!
  }];
}
