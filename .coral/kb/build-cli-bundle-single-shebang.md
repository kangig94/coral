# Keep Only One Shebang in the Built CLI Bundle
Promoted: 2026-03-13 | Updated: 2026-03-13
## Rule
When a Node CLI bundle already prepends `#!/usr/bin/env node` through esbuild `banner.js`, do not also keep a source-file shebang in the TypeScript entrypoint. The executable contract is "one shebang in the final emitted bundle," not "one in source plus one in the build banner."
## Why
`tsc` preserves the source shebang when emitting `dist/...js`, and esbuild then prepends its own banner shebang. The resulting bundle starts with two shebang lines, which makes Node treat line 2 as invalid JavaScript and crash before the CLI can parse arguments.
## Pattern
```js
await esbuild.build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'bridge/coral-cli.cjs',
  banner: { js: '#!/usr/bin/env node\n' + sharedOpts.banner.js },
});
```

```ts
// Right: no source shebang in src/cli/main.ts
declare const __PLUGIN_ROOT__: string;
```

```ts
// Wrong: duplicates the banner shebang in the built bundle.
#!/usr/bin/env node
declare const __PLUGIN_ROOT__: string;
```
