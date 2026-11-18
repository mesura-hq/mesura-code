import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __setClientSettingsForTests } from "../hooks/useSettings";
import { createFakeMedia, FakeMediaRecorder } from "./dictationMedia.testFixtures";
import { openDictationRecording, setDictationMediaBackend } from "./recorder";

afterEach(() => setDictationMediaBackend(null));

describe("dictation recorder setup", () => {
  it("dictation phase 4 regression: a recorder that cannot be created releases the microphone", async () => {
    const media = createFakeMedia();
    setDictationMediaBackend(media.backend);
    media.failRecorder("create");
    await expect(openDictationRecording()).rejects.toThrow("recorder setup failed");
    expect(media.stoppedTracks).toEqual([1]);
  });

  it("dictation phase 4 regression: a recorder that cannot start releases the microphone and its meter", async () => {
    const media = createFakeMedia();
    setDictationMediaBackend(media.backend);
    media.failRecorder("start");
    await expect(openDictationRecording()).rejects.toThrow("recorder start failed");
    expect(media.stoppedTracks).toEqual([1]);
    expect(media.meterCloses).toEqual([1]);
  });
});

describe("dictation recorder microphone", () => {
  type Device = { readonly deviceId: string; readonly label: string };

  function stubBrowserMicrophones(devices: ReadonlyArray<Device>, refuse: ReadonlySet<string>) {
    const opened: MediaStreamConstraints[] = [];
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => devices.map((device) => ({ ...device, kind: "audioinput" })),
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          opened.push(constraints);
          const audio = constraints.audio;
          const exact =
            typeof audio === "object" && typeof audio.deviceId === "object"
              ? (audio.deviceId as { exact: string }).exact
              : "";
          if (refuse.has(exact)) {
            throw Object.assign(new Error("gone"), { name: "OverconstrainedError" });
          }
          return { getTracks: () => [{ stop: () => undefined }] } as unknown as MediaStream;
        },
      },
    });
    vi.stubGlobal(
      "MediaRecorder",
      class extends FakeMediaRecorder {
        static isTypeSupported = (mimeType: string) => mimeType.startsWith("audio/webm");
        constructor(_stream: MediaStream, options: MediaRecorderOptions) {
          super(options);
        }
      },
    );
    return opened;
  }

  function saveMicrophoneOrder(order: ClientSettings["voiceMicrophones"]) {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, voiceMicrophones: order });
  }

  const usb = { kind: "device", deviceId: "usb", label: "USB mic" } as const;
  const headset = { kind: "device", deviceId: "headset", label: "Headset" } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  });

  it("records from the first connected microphone in the saved order", async () => {
    saveMicrophoneOrder([usb, headset, { kind: "default" }]);
    const opened = stubBrowserMicrophones([headset, usb], new Set());
    (await openDictationRecording()).discard();
    expect(opened).toEqual([{ audio: { deviceId: { exact: "usb" } } }]);
  });

  it("skips a saved microphone that is not connected", async () => {
    saveMicrophoneOrder([usb, headset, { kind: "default" }]);
    const opened = stubBrowserMicrophones([headset], new Set());
    (await openDictationRecording()).discard();
    expect(opened).toEqual([{ audio: { deviceId: { exact: "headset" } } }]);
  });

  it("falls back to the system default when the chosen microphone cannot open", async () => {
    saveMicrophoneOrder([usb, { kind: "default" }]);
    const opened = stubBrowserMicrophones([usb], new Set(["usb"]));
    (await openDictationRecording()).discard();
    expect(opened).toEqual([{ audio: { deviceId: { exact: "usb" } } }, { audio: true }]);
  });

  it("uses the system default when the order names no connected microphone", async () => {
    saveMicrophoneOrder([usb, { kind: "default" }, headset]);
    const opened = stubBrowserMicrophones([headset], new Set());
    (await openDictationRecording()).discard();
    expect(opened).toEqual([{ audio: true }]);
  });
});

describe("dictation recorder microphone fallback", () => {
  type Device = { readonly deviceId: string; readonly label: string };
  const usb = { kind: "device", deviceId: "usb", label: "USB mic" } as const;
  const headset = { kind: "device", deviceId: "headset", label: "Headset" } as const;
  const exact = (deviceId: string) => ({ audio: { deviceId: { exact: deviceId } } });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  });

  function stub(
    devices: ReadonlyArray<Device>,
    refuse: ReadonlySet<string>,
    options: { hidden?: boolean; refuseWhileHidden?: boolean } = {},
  ) {
    const opened: MediaStreamConstraints[] = [];
    const stopped: number[] = [];
    let permitted = !options.hidden;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () =>
          devices.map((device) =>
            permitted
              ? { ...device, kind: "audioinput" }
              : { deviceId: "", label: "", kind: "audioinput" },
          ),
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          opened.push(constraints);
          const index = opened.length;
          const audio = constraints.audio;
          const id =
            typeof audio === "object" && typeof audio.deviceId === "object"
              ? (audio.deviceId as { exact: string }).exact
              : "";
          if (refuse.has(id) && (!options.refuseWhileHidden || !permitted)) {
            throw Object.assign(new Error("gone"), { name: "NotFoundError" });
          }
          permitted = true;
          return {
            getTracks: () => [{ stop: () => stopped.push(index) }],
          } as unknown as MediaStream;
        },
      },
    });
    vi.stubGlobal(
      "MediaRecorder",
      class extends FakeMediaRecorder {
        static isTypeSupported = (mimeType: string) => mimeType.startsWith("audio/webm");
        constructor(_stream: MediaStream, options: MediaRecorderOptions) {
          super(options);
        }
      },
    );
    return { opened, stopped };
  }

  it("tries the next saved microphone before the system default", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      voiceMicrophones: [usb, headset, { kind: "default" }],
    });
    const media = stub([usb, headset], new Set(["usb"]));
    (await openDictationRecording()).discard();
    expect(media.opened).toEqual([exact("usb"), exact("headset")]);
  });

  it("tries the saved microphones in order while the browser hides their ids", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      voiceMicrophones: [usb, headset, { kind: "default" }],
    });
    const media = stub([usb, headset], new Set(["usb"]), { hidden: true });
    (await openDictationRecording()).discard();
    expect(media.opened).toEqual([exact("usb"), exact("headset")]);
  });

  it("switches to the preferred microphone once a first permission reveals it", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      voiceMicrophones: [usb, { kind: "default" }],
    });
    const media = stub([usb], new Set(["usb"]), { hidden: true, refuseWhileHidden: true });
    (await openDictationRecording()).discard();
    expect(media.opened).toEqual([exact("usb"), { audio: true }, exact("usb")]);
    expect(media.stopped).toContain(2);
  });

  it("stops at a denied permission instead of trying other microphones", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      voiceMicrophones: [usb, headset, { kind: "default" }],
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [usb, headset].map((d) => ({ ...d, kind: "audioinput" })),
        getUserMedia: vi.fn(async () => {
          throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        }),
      },
    });
    await expect(openDictationRecording()).rejects.toThrow("denied");
    expect(vi.mocked(navigator.mediaDevices.getUserMedia)).toHaveBeenCalledOnce();
  });
});
