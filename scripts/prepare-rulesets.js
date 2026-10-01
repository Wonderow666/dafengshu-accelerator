'use strict';

/**
 * 打包前置：把国内分流规则集固化到 resources/ruleset/，让安装包开箱即可离线分流。
 *
 *   node scripts/prepare-rulesets.js
 *
 * 已有的会被跳过（要强制刷新加 --force）。
 */

const fs = require('fs');
const path = require('path');
const { ensureDir, builtinRuleSetsDir } = require('../src/core/paths');
const geo = require('../src/core/geo');

async function main() {
  const force = process.argv.includes('--force');
  const dir = ensureDir(builtinRuleSetsDir());
  console.log(`目标目录: ${dir}`);

  for (const [tag, meta] of Object.entries(geo.RULE_SETS)) {
    const target = path.join(dir, meta.file);
    if (fs.existsSync(target) && !force) {
      const size = fs.statSync(target).size;
      console.log(`✓ 已存在，跳过: ${meta.file}（${(size / 1024).toFixed(0)} KB）`);
      continue;
    }

    // 优先从用户缓存搬过来（离线可用），否则走镜像下载
    const cached = geo.cachedRuleSet(tag);
    if (cached && !force) {
      fs.copyFileSync(cached, target);
      console.log(`✓ 从缓存复制: ${meta.file}（${(fs.statSync(target).size / 1024).toFixed(0)} KB）`);
      continue;
    }

    process.stdout.write(`→ 下载 ${meta.label} … `);
    const result = await geo.ensureRuleSets({ force: true, timeout: 20000 });
    const downloaded = result.files[tag];
    if (downloaded && fs.existsSync(downloaded)) {
      fs.copyFileSync(downloaded, target);
      console.log(`✓ ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
    } else {
      console.log('✗ 失败（应用首次运行时会自动重试，且可回退内置 geo 库）');
      process.exitCode = 1;
    }
  }

  console.log('\n当前内置规则集:');
  for (const file of fs.readdirSync(dir)) {
    console.log(`  ${file}  ${(fs.statSync(path.join(dir, file)).size / 1024).toFixed(0)} KB`);
  }
}

main().catch((error) => {
  console.error(`准备规则集失败: ${error.message}`);
  process.exitCode = 1;
});
