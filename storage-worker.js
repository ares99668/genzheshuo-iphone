// Store MediaRecorder chunks as they are produced, without holding a long video in RAM.
let access;
let offset = 0;
let pending = Promise.resolve();

async function handle({ id, type, name, blob }) {
  try {
    if (type === "open") {
      const directory = await navigator.storage.getDirectory();
      const file = await directory.getFileHandle(name, { create:true });
      access = await file.createSyncAccessHandle();
      access.truncate(0);
      offset = 0;
    }
    if (type === "append") {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let written = 0;
      while (written < bytes.length) {
        const count = access.write(bytes.subarray(written), { at:offset });
        if (count <= 0) throw new Error("手机剩余空间不足");
        written += count;
        offset += count;
      }
    }
    if (type === "finish") {
      access.flush();
      access.close();
      access = null;
    }
    self.postMessage({ id, ok:true });
  } catch (error) {
    access?.close();
    access = null;
    self.postMessage({ id, ok:false, message:error.message });
  }
}
self.onmessage = ({data}) => { pending = pending.then(() => handle(data)); };
