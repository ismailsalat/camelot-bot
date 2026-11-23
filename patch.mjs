#!/usr/bin/env node
/**
 * Applies the clickable-mention change to Camelot.
 *
 * Safe to run twice: every edit checks whether it has already been made.
 * Run from the project folder:   node patch.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

let changed = 0;
let skipped = 0;
let failed = 0;

function edit(file, label, from, to) {
  if (!existsSync(file)) {
    console.log(`  MISSING  ${file}`);
    failed += 1;
    return;
  }
  const before = readFileSync(file, 'utf8');
  if (before.includes(to)) {
    console.log(`  already  ${label}`);
    skipped += 1;
    return;
  }
  if (!before.includes(from)) {
    console.log(`  NOT FOUND  ${label}  (in ${file})`);
    failed += 1;
    return;
  }
  writeFileSync(file, before.split(from).join(to));
  console.log(`  patched  ${label}`);
  changed += 1;
}

console.log('\nCamelot — clickable mentions\n');

// 1. The Purge card shows a mention beside the name.
edit(
  'src/purge/ui.ts',
  'purge card mention',
  '`**${member.displayName}**\\n${stats.join(\'\\n\')}`',
  '`${member.toString()}  \u00b7  **${member.displayName}**\\n${stats.join(\'\\n\')}`',
);

// 2. The Activity card does the same.
edit(
  'src/activity/ui.ts',
  'activity card mention',
  '`**${member.displayName}**\\n${lines.join(\'\\n\')}`',
  '`${member.toString()}  \u00b7  **${member.displayName}**\\n${lines.join(\'\\n\')}`',
);

// 3. Nothing the bot sends may ping. Guard every screen.
{
  const file = 'src/core/router.ts';
  if (!existsSync(file)) {
    console.log(`  MISSING  ${file}`);
    failed += 1;
  } else {
    let src = readFileSync(file, 'utf8');
    const had = (src.match(/allowedMentions: NO_MENTIONS/g) || []).length;

    if (!src.includes("import { NO_MENTIONS }")) {
      src = src.replace(
        "import { isSoftError, soft } from '../util/discord.js';",
        "import { NO_MENTIONS } from '../util/mentions.js';\nimport { isSoftError, soft } from '../util/discord.js';",
      );
    }

    // Inline payloads.
    src = src.split('flags: V2_FLAGS } as never)').join('flags: V2_FLAGS, allowedMentions: NO_MENTIONS } as never)');
    src = src.replace(
      "    const payload = { components: [errorNotice(message)], flags: V2_FLAGS } as never;",
      "    const payload = {\n      components: [errorNotice(message)],\n      flags: V2_FLAGS,\n      allowedMentions: NO_MENTIONS,\n    } as never;",
    );

    // Multi-line payloads: add the guard under each lone "flags: V2_FLAGS," line.
    const lines = src.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i]);
      if (/^\s*flags: V2_FLAGS,\s*$/.test(lines[i])) {
        const next = lines[i + 1] || '';
        if (!next.includes('allowedMentions')) {
          out.push(lines[i].replace('flags: V2_FLAGS,', 'allowedMentions: NO_MENTIONS,'));
        }
      }
    }
    src = out.join('\n');

    const now = (src.match(/allowedMentions: NO_MENTIONS/g) || []).length;
    if (now > had) {
      writeFileSync(file, src);
      console.log(`  patched  router: ${now} send(s) now suppress mentions`);
      changed += 1;
    } else {
      console.log(`  already  router guards (${now})`);
      skipped += 1;
    }
  }
}

console.log(`\n${changed} patched, ${skipped} already done, ${failed} failed\n`);
if (failed > 0) {
  console.log('Something did not match. Nothing is broken — run `npm run build` to confirm.');
  process.exit(1);
}
console.log('Next:  npm run build   then   git add -A && git commit -m "Clickable mentions" && git push\n');
