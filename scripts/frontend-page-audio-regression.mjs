import assert from "node:assert/strict";
import { createPageAudioCoordinator } from "../public/frontend/media/page-audio.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class FakeAudio {
  constructor(src = "", playResult = null) {
    this.src = src;
    this.currentTime = 0;
    this.pauseCalls = 0;
    this.playCalls = 0;
    this.loadCalls = 0;
    this.removedSources = 0;
    this.playResult = playResult;
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, once: options.once === true });
    this.listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type) || [];
    this.listeners.set(type, entries.filter(entry => entry.listener !== listener));
  }

  emit(type) {
    const entries = [...(this.listeners.get(type) || [])];
    for (const entry of entries) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener({ target: this, type });
    }
  }

  pause() {
    this.pauseCalls += 1;
  }

  play() {
    this.playCalls += 1;
    if (this.playResult instanceof Error) return Promise.reject(this.playResult);
    if (this.playResult) return this.playResult;
    return Promise.resolve();
  }

  removeAttribute(name) {
    assert.equal(name, "src");
    this.src = "";
    this.removedSources += 1;
  }

  load() {
    this.loadCalls += 1;
  }
}

function createHarness() {
  const createdUrls = [];
  const revokedUrls = [];
  const audios = [];
  let nextPlayResult = null;
  const coordinator = createPageAudioCoordinator({
    createAudio(source) {
      const audio = new FakeAudio(source, nextPlayResult);
      nextPlayResult = null;
      audios.push(audio);
      return audio;
    },
    createObjectURL(blob) {
      const url = `blob:page-audio-${createdUrls.length + 1}`;
      createdUrls.push([url, blob]);
      return url;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    }
  });
  return {
    audios,
    coordinator,
    createdUrls,
    revokedUrls,
    setNextPlayResult(value) {
      nextPlayResult = value;
    }
  };
}

assert.throws(
  () => createPageAudioCoordinator({ createAudio: null }),
  /requires createAudio/
);

{
  const { coordinator, revokedUrls } = createHarness();
  assert.deepEqual(
    Object.keys(coordinator).sort(),
    ["claim", "playBlob", "resetSession", "stop", "stopAll"]
  );

  const thoughtSpeech = new FakeAudio("/api/speech/audio?id=thought-1");
  const captureOriginal = new FakeAudio("/attachments/capture-1.m4a");
  thoughtSpeech.currentTime = 19;
  captureOriginal.currentTime = 8;

  assert.equal(coordinator.claim(thoughtSpeech), true);
  assert.equal(coordinator.claim(thoughtSpeech), true);
  assert.equal(thoughtSpeech.pauseCalls, 0, "repeated claim must not pause the same audio");
  assert.equal(thoughtSpeech.currentTime, 19, "repeated claim must not rewind the same audio");

  assert.equal(coordinator.claim(captureOriginal), true);
  assert.equal(thoughtSpeech.pauseCalls, 1, "capture original must exclude thought speech");
  assert.equal(thoughtSpeech.currentTime, 0);
  assert.equal(coordinator.stop(captureOriginal), true);
  assert.equal(captureOriginal.pauseCalls, 1);
  assert.equal(captureOriginal.currentTime, 0);
  assert.deepEqual(revokedUrls, [], "persistent audio addresses must never be revoked");
}

{
  const {
    audios,
    coordinator,
    createdUrls,
    revokedUrls
  } = createHarness();
  const persistent = new FakeAudio("/api/speech/audio?id=thought-2");
  persistent.currentTime = 13;
  coordinator.claim(persistent);

  let requestSignal;
  const audio = await coordinator.playBlob(({ signal }) => {
    requestSignal = signal;
    return Promise.resolve({ id: "preview-success" });
  });

  assert.equal(requestSignal.aborted, false);
  assert.equal(persistent.pauseCalls, 1);
  assert.equal(persistent.currentTime, 0);
  assert.equal(audio, audios[0]);
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.src, "blob:page-audio-1");
  assert.deepEqual(createdUrls, [["blob:page-audio-1", { id: "preview-success" }]]);
  assert.equal(coordinator.claim(audio), true);
  assert.equal(audio.pauseCalls, 0, "native play re-claim must not reset managed audio");

  assert.equal(coordinator.stop(audio), true);
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.removedSources, 1);
  assert.equal(audio.loadCalls, 1);
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
  coordinator.stop(audio);
  coordinator.resetSession();
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"], "managed URL must be revoked once");
}

{
  const { audios, coordinator, revokedUrls } = createHarness();
  const audio = await coordinator.playBlob(async () => ({ id: "preview-ended" }));
  audio.currentTime = 7;
  audio.emit("ended");
  audio.emit("ended");
  coordinator.stopAll();
  assert.equal(audios[0].pauseCalls, 1);
  assert.equal(audios[0].currentTime, 0);
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
}

{
  const {
    audios,
    coordinator,
    revokedUrls,
    setNextPlayResult
  } = createHarness();
  const playError = new Error("autoplay denied");
  setNextPlayResult(playError);
  await assert.rejects(
    coordinator.playBlob(async () => ({ id: "preview-failure" })),
    error => error === playError
  );
  assert.equal(audios[0].playCalls, 1);
  assert.equal(audios[0].pauseCalls, 1);
  assert.equal(audios[0].removedSources, 1);
  assert.equal(audios[0].loadCalls, 1);
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
  coordinator.resetSession();
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
}

{
  const revokedUrls = [];
  const coordinator = createPageAudioCoordinator({
    createAudio() {
      throw new Error("audio construction failed");
    },
    createObjectURL: () => "blob:construction-failure",
    revokeObjectURL: url => revokedUrls.push(url)
  });
  await assert.rejects(
    coordinator.playBlob(async () => ({ id: "construction-failure" })),
    /audio construction failed/
  );
  coordinator.resetSession();
  assert.deepEqual(revokedUrls, ["blob:construction-failure"]);
}

{
  const {
    audios,
    coordinator,
    createdUrls,
    revokedUrls
  } = createHarness();
  const load = deferred();
  let requestSignal;
  const playback = coordinator.playBlob(({ signal }) => {
    requestSignal = signal;
    return load.promise;
  });

  assert.equal(requestSignal.aborted, false);
  assert.equal(coordinator.resetSession(), true);
  assert.equal(requestSignal.aborted, true);
  assert.equal(coordinator.resetSession(), false);
  load.resolve({ id: "late-after-reset" });
  assert.equal(await playback, null);
  assert.deepEqual(createdUrls, [], "late reset Blob must not create an object URL");
  assert.deepEqual(audios, [], "late reset Blob must not create or play audio");
  assert.deepEqual(revokedUrls, []);
}

{
  const {
    audios,
    coordinator,
    createdUrls
  } = createHarness();
  const load = deferred();
  const unmount = new AbortController();
  let requestSignal;
  const playback = coordinator.playBlob(({ signal }) => {
    requestSignal = signal;
    return load.promise;
  }, { signal: unmount.signal });

  unmount.abort();
  assert.equal(requestSignal.aborted, true);
  load.resolve({ id: "late-after-unmount" });
  assert.equal(await playback, null);
  assert.deepEqual(createdUrls, [], "late unmount Blob must not create an object URL");
  assert.deepEqual(audios, [], "late unmount Blob must not create or play audio");
}

{
  const {
    audios,
    coordinator,
    revokedUrls,
    setNextPlayResult
  } = createHarness();
  const play = deferred();
  setNextPlayResult(play.promise);
  const playback = coordinator.playBlob(async () => ({ id: "reset-during-play" }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(audios.length, 1);
  assert.equal(audios[0].playCalls, 1);

  assert.equal(coordinator.resetSession(), true);
  assert.equal(coordinator.resetSession(), false);
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
  play.resolve();
  assert.equal(await playback, null);
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
}

{
  const {
    coordinator,
    createdUrls,
    revokedUrls
  } = createHarness();
  const unmount = new AbortController();
  const audio = await coordinator.playBlob(
    async () => ({ id: "abort-after-play" }),
    { signal: unmount.signal }
  );
  unmount.abort();
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.currentTime, 0);
  assert.deepEqual(createdUrls.map(([url]) => url), ["blob:page-audio-1"]);
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
  coordinator.resetSession();
  assert.deepEqual(revokedUrls, ["blob:page-audio-1"]);
}

{
  const {
    audios,
    coordinator,
    createdUrls
  } = createHarness();
  const captureOriginal = new FakeAudio("/attachments/capture-stop-all.m4a");
  const load = deferred();
  let requestSignal;
  coordinator.claim(captureOriginal);
  const playback = coordinator.playBlob(({ signal }) => {
    requestSignal = signal;
    return load.promise;
  });

  assert.equal(coordinator.stopAll(), true);
  assert.equal(captureOriginal.pauseCalls, 1);
  assert.equal(captureOriginal.currentTime, 0);
  assert.equal(requestSignal.aborted, true);
  load.resolve({ id: "late-after-stop-all" });
  assert.equal(await playback, null);
  assert.deepEqual(createdUrls, []);
  assert.deepEqual(audios, []);
}

console.log(
  "Frontend page audio checks passed: exclusivity, late Blob isolation, reset and exact URL cleanup."
);
