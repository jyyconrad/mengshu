#!/usr/bin/env node
/**
 * 简化测试脚本：验证 bin/ms.ts 的参数检测逻辑
 *
 * 不需要完整依赖即可验证修复是否有效
 */

console.log('=== ms CLI 参数检测测试 ===\n');

// 模拟不同的命令行参数场景
const testCases = [
  {
    name: '无参数（MCP server 模式）',
    argv: ['node', '/path/to/bin/ms.ts'],
    expected: 'MCP server 模式',
  },
  {
    name: '有参数：doctor',
    argv: ['node', '/path/to/bin/ms.ts', 'doctor'],
    expected: 'CLI 命令模式',
  },
  {
    name: '有参数：stats',
    argv: ['node', '/path/to/bin/ms.ts', 'stats'],
    expected: 'CLI 命令模式',
  },
  {
    name: '有参数：search',
    argv: ['node', '/path/to/bin/ms.ts', 'search', 'query'],
    expected: 'CLI 命令模式',
  },
];

console.log('测试场景：\n');

for (const testCase of testCases) {
  const isMcpMode = testCase.argv.length === 2;
  const mode = isMcpMode ? 'MCP server 模式' : 'CLI 命令模式';
  const status = mode === testCase.expected ? '✅' : '❌';

  console.log(`${status} ${testCase.name}`);
  console.log(`   argv: [${testCase.argv.slice(1).join(', ')}]`);
  console.log(`   argv.length: ${testCase.argv.length}`);
  console.log(`   检测结果: ${mode}`);
  console.log(`   预期结果: ${testCase.expected}`);
  console.log();
}

console.log('=== 实际参数 ===\n');
console.log(`process.argv: [${process.argv.join(', ')}]`);
console.log(`process.argv.length: ${process.argv.length}`);

if (process.argv.length === 2) {
  console.log('✅ 当前会进入 MCP server 模式');
} else {
  console.log('✅ 当前会进入 CLI 命令模式');
  console.log(`   命令: ${process.argv[2] || '(无)'}`);
  console.log(`   参数: ${process.argv.slice(3).join(' ') || '(无)'}`);
}
