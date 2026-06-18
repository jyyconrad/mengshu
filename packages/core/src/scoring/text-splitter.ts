import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

export interface TextSplitOptions {
  /** 每个分片的最大字符数 */
  chunkSize?: number;
  /** 分片之间的重叠字符数 */
  chunkOverlap?: number;
  /** 分隔符优先级，默认按Markdown分隔符 */
  separators?: string[];
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_SEPARATORS = [
  "\n## ", // Markdown 二级标题
  "\n### ", // Markdown 三级标题
  "\n#### ", // Markdown 四级标题
  "\n##### ", // Markdown 五级标题
  "\n###### ", // Markdown 六级标题
  "\n\n", // 段落
  "\n", // 换行
  ". ", // 句子
  "! ",
  "? ",
  " ", // 空格
  "", // 字符
];

/**
 * 智能文本切片器
 * 基于langchain的RecursiveCharacterTextSplitter，优化Markdown文档切片效果
 */
export class TextSplitter {
  private splitter: RecursiveCharacterTextSplitter;

  constructor(options: TextSplitOptions = {}) {
    this.splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      chunkOverlap: options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
      separators: options.separators ?? DEFAULT_SEPARATORS,
    });
  }

  /**
   * 切分单个文本
   * @param text 要切分的文本
   * @returns 切分后的文本片段数组
   */
  async splitText(text: string): Promise<string[]> {
    return this.splitter.splitText(text);
  }

  /**
   * 批量切分文本
   * @param texts 文本数组
   * @returns 切分后的所有文本片段
   */
  async splitTexts(texts: string[]): Promise<string[]> {
    const results = await Promise.all(texts.map(text => this.splitText(text)));
    return results.flat();
  }
}
