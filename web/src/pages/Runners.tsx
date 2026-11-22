import { useState, type FormEvent } from "react";
import { useClaudeSetup, useRemoveClaudeKey, useSaveClaudeKey, type ClaudeSetup } from "../api/claude";
import { Button, PageHead, Pill } from "../ui/parts";
import { useToast } from "../ui/Toast";

function status(s: ClaudeSetup): { tone: "ok" | "warn" | "idle"; pill: string; text: string } {
  switch (s.using) {
    case "subscription":
      return { tone: "ok", pill: "subscription", text: "Your agents run on your Claude subscription, through Claude Code in a Cloudflare sandbox." };
    case "own_key":
      return { tone: "ok", pill: "your key", text: `Your agents use your own Anthropic API key ending in ${s.keyHint}. Usage is billed to your Anthropic account.` };
    case "server_key":
      return { tone: "warn", pill: "shared key", text: "Your agents use this server's API key. Add your own to have usage billed to you." };
    default:
      return { tone: "idle", pill: "not set up", text: "Claude is not set up yet. Add an Anthropic API key to run agents." };
  }
}

/** Where the signed-in user's agents get Claude from, and their own API key. */
function ClaudeCard() {
  const toast = useToast();
  const setup = useClaudeSetup();
  const save = useSaveClaudeKey();
  const remove = useRemoveClaudeKey();
  const [draft, setDraft] = useState("");
  if (!setup.data) return setup.error ? <span className="err" role="alert">{setup.error.message}</span> : null;
  const s = setup.data;
  const st = status(s);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    save.mutate(draft, {
      onSuccess: () => {
        setDraft("");
        toast("Key saved");
      },
    });
  }

  return (
    <section className="card pad stack" aria-labelledby="claude-h">
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <h2 id="claude-h">Claude</h2>
        <Pill tone={st.tone}>{st.pill}</Pill>
      </div>
      <p style={{ fontSize: 13 }}>{st.text}</p>
      {s.using !== "subscription" && (
        <form className="stack-s" onSubmit={onSubmit}>
          <div className="fld">
            <label htmlFor="claude-key">{s.keyHint ? "Replace your Anthropic API key" : "Anthropic API key"}</label>
            <input
              id="claude-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={draft}
              disabled={!s.canSave}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span style={{ fontSize: 12 }}>
              {s.canSave
                ? "Create one at console.anthropic.com. It is stored encrypted and never shown again. Claude subscription tokens can't be used here."
                : "This server can't save keys yet."}
            </span>
          </div>
          {save.error && <span className="err" role="alert">{save.error.message}</span>}
          {remove.error && <span className="err" role="alert">{remove.error.message}</span>}
          <div className="btns">
            <Button variant="primary" type="submit" disabled={!s.canSave || !draft.trim() || save.isPending}>
              Save key
            </Button>
            {s.keyHint && (
              <Button type="button" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => toast("Key removed") })}>
                Remove key
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

export function Runners() {
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <PageHead eyebrow="Runners · where agents run" title="Your machines and sandboxes" />
      <ClaudeCard />
    </div>
  );
}
