import { useId, useState } from "react";
import { useConnectGitlabToken, useDisconnectGitlab, useGitlab } from "../api/queries";
import { Button } from "./parts";

/** Connect (or disconnect) the person's GitLab account. Shows nothing when this server has no GitLab. */
export function GitlabConnect() {
  const id = useId();
  const status = useGitlab();
  const connect = useConnectGitlabToken();
  const disconnect = useDisconnectGitlab();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const s = status.data;
  if (!s?.configured || !s.url) return null;
  const host = s.url.replace(/^https?:\/\//, "");

  if (s.account) {
    return (
      <div className="card pad btns" style={{ justifyContent: "space-between" }}>
        <div className="stack-s" style={{ gap: 2 }}>
          <b>GitLab</b>
          <span className="sub" style={{ fontSize: 12.5 }}>
            Connected to {host} as <span className="mono">@{s.account.username}</span>
            {s.account.kind === "token" ? " with a personal access token" : ""}. Add its repos above.
          </span>
        </div>
        <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
          Disconnect
        </Button>
      </div>
    );
  }

  const tokenUrl = `${s.url}/-/user_settings/personal_access_tokens?name=spectrace&scopes=api`;
  return (
    <div className="card pad stack" style={{ gap: 10 }}>
      <div className="btns" style={{ justifyContent: "space-between" }}>
        <div className="stack-s" style={{ gap: 2 }}>
          <b>GitLab</b>
          <span className="sub" style={{ fontSize: 12.5 }}>Connect your account on {host} to add its repos and review merge requests here.</span>
        </div>
        {s.oauth ? (
          <a className="btn pri" href="/api/gitlab/connect" style={{ textDecoration: "none" }}>
            Connect GitLab
          </a>
        ) : (
          !showToken && <Button onClick={() => setShowToken(true)}>Connect GitLab</Button>
        )}
      </div>
      {s.oauth && !showToken && (
        <button type="button" className="chip" style={{ alignSelf: "flex-start" }} onClick={() => setShowToken(true)}>
          Use a personal access token instead
        </button>
      )}
      {showToken && (
        <div className="fld">
          <label htmlFor={id}>Personal access token</label>
          <div className="btns" style={{ flexWrap: "nowrap" }}>
            <input
              id={id}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="glpat-…"
              autoComplete="off"
              spellCheck={false}
            />
            <Button disabled={!token.trim() || connect.isPending} onClick={() => connect.mutate(token.trim(), { onSuccess: () => setToken("") })}>
              Connect
            </Button>
          </div>
          <span style={{ fontSize: 12 }}>
            Make one with the <span className="mono">api</span> scope on{" "}
            <a href={tokenUrl} target="_blank" rel="noreferrer noopener">
              {host}
            </a>
            . It is stored encrypted and never shown again.
          </span>
          {connect.error && <span className="err" role="alert">{connect.error.message}</span>}
        </div>
      )}
    </div>
  );
}
