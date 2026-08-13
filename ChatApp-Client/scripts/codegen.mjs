#!/usr/bin/env node
// Generates TypeScript types from ChatApp-Contracts JSON Schemas into src/generated/.
// Not run via the json2ts CLI's glob mode: that mode resolves every matched file's `$ref`s
// against one shared base directory instead of each file's own directory, which breaks
// rest/*.schema.json and websocket/*.schema.json referencing ../domain/*.schema.json (see
// ChatApp-Client/DESIGN.md §2). Compiling file-by-file with `cwd` set per file avoids that.
//
// Known limitation: each output file is compiled independently, so a $ref'd domain type (e.g.
// `Message`) gets its own duplicate interface generated in every file that references it, rather
// than a single shared definition. Structurally identical, so TypeScript treats them as
// interchangeable — just not DRY. Acceptable for now; revisit with a bundling step
// (`@apidevtools/json-schema-ref-parser`'s bundle()) if the duplication becomes a real problem.

import { compileFromFile } from 'json-schema-to-typescript';
import { globSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractsRoot = join(clientRoot, '..', 'ChatApp-Contracts');
const outRoot = join(clientRoot, 'src', 'generated');

const schemaFiles = globSync('**/*.schema.json', { cwd: contractsRoot });

if (schemaFiles.length === 0) {
  console.error(`No .schema.json files found under ${contractsRoot}`);
  process.exit(1);
}

for (const relPath of schemaFiles) {
  const inputFile = join(contractsRoot, relPath);
  const outputFile = join(outRoot, relPath.replace(/\.schema\.json$/, '.ts'));

  const ts = await compileFromFile(inputFile, {
    cwd: dirname(inputFile),
    bannerComment:
      '/* eslint-disable */\n' +
      `/**\n * Generated from ${relative(clientRoot, inputFile).replace(/\\/g, '/')} — do not edit by hand.\n * Run \`npm run codegen\` to regenerate.\n */`,
  });

  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, ts);
  console.log(`  ${relPath} -> ${relative(clientRoot, outputFile).replace(/\\/g, '/')}`);
}

console.log(`Generated ${schemaFiles.length} file(s) into src/generated/`);
