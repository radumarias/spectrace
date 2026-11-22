import { useCallback, useEffect, useRef, useState } from "react";

// Talking to the coordinator (requirements studio, phase 5): the browser's own
// speech recognition turns what you say into a message, and its speech
// synthesis can read the coordinator's replies aloud. Nothing leaves the
// browser but the text. Both are hidden where the browser has no support.

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Speak instead of typing. `onText` gets what was heard so far while you talk
 * (`final` false) and the whole sentence once you pause (`final` true).
 */
export function useDictation(onText: (text: string, final: boolean) => void) {
  const Ctor = recognitionCtor();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const handler = useRef(onText);
  useEffect(() => {
    handler.current = onText;
  });

  const stop = useCallback(() => rec.current?.stop(), []);
  const start = useCallback(() => {
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]!;
        text += res[0]?.transcript ?? "";
        final = res.isFinal;
      }
      handler.current(text.trim(), final);
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "The microphone is blocked for this site." : "I could not hear that. Try again.");
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    setError(null);
    setListening(true);
    try {
      r.start();
    } catch {
      rec.current = null;
      setListening(false);
    }
  }, [Ctor]);
  useEffect(() => () => rec.current?.stop(), []);
  return { supported: !!Ctor, listening, error, start, stop };
}

const ALOUD_KEY = "spectrace-read-aloud";

/** Read the coordinator's replies aloud; the choice is remembered in this browser. */
export function useReadAloud() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(ALOUD_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setOn((v) => {
      const next = !v;
      try {
        localStorage.setItem(ALOUD_KEY, next ? "1" : "0");
      } catch {
        // Remembering is a convenience only.
      }
      if (!next) window.speechSynthesis.cancel();
      return next;
    });
  }, []);
  const speak = useCallback(
    (text: string) => {
      if (!supported || !on || !text.trim()) return;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    },
    [supported, on],
  );
  return { supported, on: supported && on, toggle, speak };
}
