# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a problem

Open an issue with:

- what you asked the assistant or which tool you called, with its arguments
- what came back, and what you expected
- the output of `npx -y @pixfrixsystems/search-console-mcp doctor`
- your MCP client and operating system

Please remove property names, URLs and query data you would rather keep private. Never paste a key, client secret or token.

## Working on the code

You need Node.js 22 or newer.

```bash
npm install
npm run build        # compile to dist/
npm test             # run the tests
npm run typecheck    # types only
npm run docs:tools   # regenerate docs/tools.md after changing a tool
```

No Google credentials are needed: the tests run the real server against a stand-in for the Search Console API (`test/helpers.ts`). `test/stdio.test.ts` runs the built package, so build before testing.

If you do have credentials, `npm run live-check -- --site example.com` runs every read-only tool against a real property and checks that the numbers agree with each other. It only reads, and uses about 60 API calls and at most 7 URL inspections. Run it before a release and after any change to `src/gsc/` or to how a tool builds its request.

To try your build in a client, point it at `node /absolute/path/to/dist/index.js`.

## Layout

```
src/
  index.ts          command line entry: server, doctor, auth
  server.ts         builds the MCP server and the shared dependencies
  auth.ts           finds credentials and produces access tokens
  gsc/client.ts     the Search Console REST calls, retries and error messages
  sites.ts          matching "example.com" or a page URL to a property
  dates.ts          default periods and comparisons, in Pacific Time
  analysis/         the SEO logic as plain functions, no network
  tools/            tool definitions: input schema, API calls, output shape
  prompts.ts        the ready-made workflows
```

Keep that split. Logic that decides something about SEO data belongs in `analysis/` as a pure function with tests. Tool files fetch, call it and format.

## What makes a good change

- **A new tool answers a question people ask**, and returns something to act on. If `search_analytics` with the right arguments already answers it, improve the docs instead.
- **Say what the numbers do not show.** If a result depends on a threshold, a sample or a row cap, the output says so in `notes`.
- **Errors tell the reader what to do.** Throw `UserError` with a hint for anything the caller can fix.
- **Output stays compact.** Tables are `{ columns, rows }`. Round numbers. Default to a short list with a `limit` parameter.
- **Tool descriptions are for the model.** Say what the tool is for and when to choose it, in plain words.
- **Tests come with the change.** Analysis functions get unit tests; tools get a case in `test/server.test.ts`.

## Pull requests

- One logical change per pull request.
- Commit messages follow the Angular convention: `type(scope): subject`, for example `feat(tools): add find_orphan_queries` or `fix(auth): refresh token before expiry`.
- Run `npm run check` and `npm run build` before pushing.
- Update `CHANGELOG.md` and, if you touched a tool, run `npm run docs:tools`.

By contributing you agree that your work is released under the project's [MIT license](LICENSE).
