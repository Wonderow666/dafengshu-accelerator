'use strict';

/**
 * 用 Windows 自带的离线 OCR 引擎（Windows.Media.Ocr）识别图片文字。
 *
 * 为什么需要它：远端的视觉模型接口会限流/不可用，而 Windows 11 本身
 * 就带了本地 OCR 引擎，完全离线、支持中文，适合识别终端截图里的一行行文字。
 *
 * 用法:
 *   node scripts/ocr.js <图片路径>
 *   node scripts/ocr.js <图片路径> --lang zh-Hans-CN
 *
 * 说明：OCR 只做「文字提取」，不理解画面。识别终端日志、命令输出这类
 * 等宽字体内容效果不错；对复杂排版或艺术字效果一般。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function runPowerShell(script, timeout = 60000) {
  const file = path.join(os.tmpdir(), `dfsj-ocr-${Date.now()}.ps1`);
  // 写成 UTF-8 with BOM，确保 PowerShell 正确读取中文
  fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    );
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 查看系统里有哪些可用的 OCR 语言包 */
function listLanguages() {
  const script = `
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] > $null
$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
foreach ($l in $langs) { Write-Output $l.LanguageTag }
`;
  try {
    return runPowerShell(script)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

/** 对图片做 OCR，返回识别出的行数组 */
function recognize(imagePath, languageTag) {
  const absolute = path.resolve(imagePath);
  if (!fs.existsSync(absolute)) throw new Error(`图片不存在: ${absolute}`);

  const escaped = absolute.replace(/'/g, "''");
  const engineLine = languageTag
    ? `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('${languageTag}'))`
    : `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()`;

  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# WinRT 类型与 await 互操作都需要先加载
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] > $null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] > $null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime] > $null
[Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime] > $null

# PowerShell 5.1 里没有 AsTask() 扩展可用，这里用反射调用同名的静态泛型方法
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

${engineLine}
if ($null -eq $engine) { Write-Error '无法创建 OCR 引擎：可能缺少对应语言的 OCR 语言包'; exit 2 }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${escaped}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

foreach ($line in $result.Lines) { Write-Output $line.Text }
`;
  const output = runPowerShell(script);
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line, index, all) => !(line === '' && index === all.length - 1));
}

function main() {
  const args = process.argv.slice(2);
  const imagePath = args.find((a) => !a.startsWith('--'));
  const langIndex = args.indexOf('--lang');
  const languageTag = langIndex >= 0 ? args[langIndex + 1] : undefined;

  if (!imagePath) {
    console.log('用法: node scripts/ocr.js <图片路径> [--lang zh-Hans-CN]');
    console.log('\n可用的 OCR 语言包:');
    const langs = listLanguages();
    if (langs.length) langs.forEach((l) => console.log('  ' + l));
    else console.log('  (读取失败，可能是当前用户没有安装 OCR 语言包)');
    return;
  }

  const lines = recognize(imagePath, languageTag);
  if (!lines.length) {
    console.log('(未识别出文字)');
    return;
  }
  lines.forEach((line) => console.log(line));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`OCR 失败: ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

module.exports = { recognize, listLanguages };
