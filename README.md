# postgres-ts-plugin

> Realtime SQL queries validation for `postgres`

This TypeScript plugin validate SQL in string templates using the `sql` tag from the [`postgres`](https://github.com/porsager/postgres) package

## Features

 * [X] Tagged templates detection based on the *tag type* rather than the *tag name* (no false positives or contraints on the tag name)
 * [X] Works out of the box (update your `tsconfig.json` and it *just works*, no generation step or so)
 * [X] Cache and throttle queries evaluation
 * [ ] *IntelliSense (soon ?)*

## Usage

Install the `postgres-ts-plugin` package and update your `tsconfig.json`:

```js
{
  // ...
  "compilerOptions": {
    // ...
    "plugins": [
      {
        "name": "postgres-ts-plugin"

        // You can also pass options directly to `postgres` - just uncomment the following line
        // "options": { /* your options here */ }
      }
    ]
    // ...
  }
  // ...
}
```

Then, just setup your VSCode to use the TypeScript version of your workspace (in order to activate the plugin).
Your SQL requests should now be validated against your PostgreSQL server.
Valid requests show their costs on the `sql` tag.
