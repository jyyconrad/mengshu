import { join, relative } from "node:path";
import ignore from "ignore";
import { glob } from "glob";

export interface FileScannerOptions {
  /** 要忽略的路径模式 */
  ignorePaths?: string[];
  /** 自定义gitignore风格的忽略规则 */
  ignoreRules?: string[];
  /** 是否包含隐藏文件 */
  includeHidden?: boolean;
  /** 要扫描的文件扩展名 */
  extensions?: string[];
}

const DEFAULT_IGNORE_PATHS = [
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  "dist",
  "build",
  "coverage",
  "*.log",
  "*.tmp",
  "*.temp",
];

const DEFAULT_EXTENSIONS = [".md", ".mdx"];

/**
 * 文件扫描器
 * 递归扫描目录下的文件，支持忽略规则
 */
export class FileScanner {
  private ig: ReturnType<typeof ignore>;
  private options: Required<FileScannerOptions>;

  constructor(options: FileScannerOptions = {}) {
    this.options = {
      ignorePaths: options.ignorePaths ?? DEFAULT_IGNORE_PATHS,
      ignoreRules: options.ignoreRules ?? [],
      includeHidden: options.includeHidden ?? false,
      extensions: options.extensions ?? DEFAULT_EXTENSIONS,
    };

    this.ig = ignore();
    this.ig.add(this.options.ignorePaths);
    this.ig.add(this.options.ignoreRules);
  }

  /**
   * 扫描目录下的所有符合条件的文件
   * @param rootDir 根目录路径
   * @returns 符合条件的文件路径数组（绝对路径）
   */
  async scan(rootDir: string): Promise<string[]> {
    const pattern = join(rootDir, "**", `*.{${this.options.extensions.map(ext => ext.replace('.', '')).join(',')}}`);

    const files = await glob(pattern, {
      absolute: true,
      dot: this.options.includeHidden,
      nodir: true,
    });

    // 应用忽略规则
    const relativeFiles = files.map(file => relative(rootDir, file));
    const filteredRelativeFiles = this.ig.filter(relativeFiles);

    return filteredRelativeFiles.map(file => join(rootDir, file));
  }

  /**
   * 检查文件是否应该被忽略
   * @param filePath 文件路径
   * @param rootDir 根目录路径
   * @returns 是否应该忽略
   */
  shouldIgnore(filePath: string, rootDir: string): boolean {
    const relativePath = relative(rootDir, filePath);
    return this.ig.ignores(relativePath);
  }
}
