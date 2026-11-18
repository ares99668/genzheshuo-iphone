import { Follower } from "./follower.js";
import { initASRModule, createOnlineRecognizer } from "./vendor/sherpa/index.js";

let recognizer;
let tracker;
let stream;
let opening;
let segment = 0;
let previous = "";
let session = 0;
let phonetics;

async function response(url) {
  const result = await fetch(new URL(url,import.meta.url));
  if (!result.ok || result.headers.get("content-type")?.includes("text/html")) {
    throw new Error("请重新打开页面，下载离线识别文件");
  }
  return result;
}

export async function makeRecognizer(report = () => {}) {
  const models = ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"];
  let loaded = 0;
  const modelList = Promise.all(models.map(async name => {
    const data = new Uint8Array(await (await response("./models/" + name)).arrayBuffer());
    report(++loaded, models.length);
    return [name, data];
  }));
  const [engine, files, pinyin] = await Promise.all([
    initASRModule(), modelList, response("./models/pinyin.json").then(r => r.json())
  ]);
  for (const [name,buffer] of files) engine.FS_createDataFile("/", name, buffer, true, false, true);
  const asr = createOnlineRecognizer(engine, {
    modelConfig: { debug: 0, numThreads: 1, provider: "cpu" },
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: .48,
    rule3MinUtteranceLength: 18
  });
  if (!asr?.handle) throw new Error("识别模型加载失败，请重新打开");
  return { asr, pinyin };
}

function reset(index) {
  stream?.free();
  stream = recognizer.createStream();
  tracker.reset(index);
  segment = 0;
  previous = "";
}

function update(samples) {
  stream.acceptWaveform(16000,samples);
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = recognizer.getResult(stream).text;
  const final = recognizer.isEndpoint(stream);
  if (text !== previous || (final && text)) {
    const {index,preview,character} = tracker.feed(text,segment,final);
    self.postMessage({ type:"position", session, index:preview, character:index === preview ? character : 0 });
    previous = text;
  }
  if (final) {
    recognizer.reset(stream);
    segment++;
    previous = "";
  }
}

self.onmessage = async ({data}) => {
  try {
    if (data.type === "prepare") {
      session = data.session;
      opening ??= makeRecognizer((loaded,total) => self.postMessage({type:"loading", session, loaded, total}));
      try {
        const engine = await opening;
        recognizer = engine.asr;
        phonetics = engine.pinyin;
      } catch (error) {
        opening = undefined;
        throw error;
      }
      if (session !== data.session) return;
      tracker = new Follower(data.cues,phonetics);
      reset(data.index);
      self.postMessage({type:"ready",session});
    }
    if (data.session !== session || !stream) return;
    if (data.type === "reset") reset(data.index);
    if (data.type === "samples") {
      update(data.samples);
      self.postMessage({type:"processed",session});
    }
  } catch (error) {
    self.postMessage({type:"error", session:data.session, message:error.message || "离线识别启动失败"});
  }
};
