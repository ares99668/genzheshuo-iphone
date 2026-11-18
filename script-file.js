import { unzipSync } from "./vendor/fflate.js";
const MAX_SCRIPT = 100000;
const MAX_FILE = 5 * 1024 * 1024;
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function wordDocument(bytes) {
  const { "word/document.xml":xml } = unzipSync(bytes,{
    filter:({name,originalSize}) => name === "word/document.xml" && originalSize <= 2 * 1024 * 1024
  });
  if (!xml) throw new Error("请选择体积较小的 DOCX 文件。");
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml),"application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("这个 Word 文件暂时无法读取。");
  return Array.from(doc.getElementsByTagNameNS(WORD_NS,"p"),p =>
    Array.from(p.getElementsByTagNameNS(WORD_NS,"t"),node => node.textContent).join("")).join("\n");
}

function textDocument(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try { return new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
  catch { return new TextDecoder("gb18030").decode(bytes); }
}

export async function readScript(file) {
  if (file.size > MAX_FILE) throw new Error("请导入 5 MB 以内的话术文件。");
  if (!/\.(txt|docx)$/i.test(file.name)) throw new Error("请导入 TXT 或 DOCX 话术。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = /\.docx$/i.test(file.name) ? wordDocument(bytes) : textDocument(bytes);
  if (!text.trim()) throw new Error("文档里没有读到台词。");
  if (text.length > MAX_SCRIPT) throw new Error("话术最多支持十万个字符，请缩短后导入。");
  return text;
}
