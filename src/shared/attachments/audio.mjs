const AUDIO_FORMATS = Object.freeze({
  "audio/mp4": {
    extension: "m4a",
    matches: data => data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp"
  },
  "audio/x-m4a": {
    extension: "m4a",
    canonicalMimeType: "audio/mp4",
    matches: data => data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp"
  },
  "audio/webm": {
    extension: "webm",
    matches: data => data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3
  },
  "audio/ogg": {
    extension: "ogg",
    matches: data => data.length >= 4 && data.subarray(0, 4).toString("ascii") === "OggS"
  },
  "audio/wav": {
    extension: "wav",
    matches: data => data.length >= 12
      && data.subarray(0, 4).toString("ascii") === "RIFF"
      && data.subarray(8, 12).toString("ascii") === "WAVE"
  },
  "audio/x-wav": {
    extension: "wav",
    canonicalMimeType: "audio/wav",
    matches: data => data.length >= 12
      && data.subarray(0, 4).toString("ascii") === "RIFF"
      && data.subarray(8, 12).toString("ascii") === "WAVE"
  }
});

export const AUDIO_MIME_TYPES = Object.freeze(Object.keys(AUDIO_FORMATS));

export function decodeAudioDataUrl(value, { maxBytes }) {
  const match = /^data:(audio\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value || "");
  const format = match ? AUDIO_FORMATS[match[1].toLowerCase()] : null;
  if (!format) throw new Error("只支持 M4A、WebM、Ogg 或 WAV 音频");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > maxBytes) {
    throw new Error(`音频大小不得超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  if (!format.matches(data)) throw new Error("音频内容与格式不匹配");
  return {
    data,
    mimeType: format.canonicalMimeType || match[1].toLowerCase(),
    extension: format.extension,
    bytes: data.length
  };
}
