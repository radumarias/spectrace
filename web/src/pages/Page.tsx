import { useState } from "react";
import { Button, Card, PageHead, Pill, Tabs } from "../ui/parts";
import { useToast } from "../ui/Toast";
import { TITLES } from "../shell/nav";

/** Placeholder body for pages later tasks fill in. Also shows each shared part once. */
export function Page({ route }: { route: string }) {
  const toast = useToast();
  const [tab, setTab] = useState("one");
  return (
    <div className="page">
      <PageHead eyebrow="spectrace" title={TITLES[route] ?? route} sub="This page arrives in a later task.">
        <Button onClick={() => toast("Saved")}>Show toast</Button>
        <Button variant="primary">Primary</Button>
      </PageHead>
      <Card>
        <div className="stack">
          <Tabs
            items={[{ id: "one", label: "Overview" }, { id: "two", label: "Details" }, { id: "three", label: "History" }]}
            value={tab}
            onChange={setTab}
          />
          <div className="btns">
            <Pill tone="ok">passing</Pill>
            <Pill tone="warn">drift</Pill>
            <Pill tone="bad">failing</Pill>
            <Pill tone="idle">idle</Pill>
            <Pill tone="acc">working</Pill>
          </div>
        </div>
      </Card>
    </div>
  );
}
