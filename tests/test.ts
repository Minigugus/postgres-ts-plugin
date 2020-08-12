import postgres from 'postgres';
import pg from './setup';

type Test = typeof postgres;

interface TEST extends Test { a: 1; }

declare const test: TEST;

const sql1 = test();
const sql2 = postgres();
const sql3 = pg;
const sql = async (...args: any) => {};

sql`a non SQL ${'tag'}`;
sql1`SELECT (SELECT typename FROM pg_catalog.pg_tables LIMIT 1)`;
sql2`SELECT ${2},`;

sql3.begin(sql => [
  sql`SELECT * FROM pg_catalog.pg_tables`
]);

const a = await sql1`INSERT INTO test (id) VALUES(${null});`;
