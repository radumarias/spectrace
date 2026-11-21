import { useEffect, useState } from "react";

export function App() {
  const [status, setStatus] = useState("checking…");
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j: { status: string }) => setStatus(j.status))
      .catch(() => setStatus("server not reachable"));
  }, []);
  return (
    <main style={{ fontFamily: "system-ui", padding: 16 }}>
      <h1>spectrace</h1>
      <p>Server: {status}</p>
    </main>
  );
}
