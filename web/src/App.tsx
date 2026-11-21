import { Navigate, Route, Routes } from "react-router-dom";
import { NewProject } from "./pages/NewProject";
import { Page } from "./pages/Page";
import { ProjectHome } from "./pages/ProjectHome";
import { ProjectSettings } from "./pages/ProjectSettings";
import { Projects } from "./pages/Projects";
import { PullRequests } from "./pages/PullRequests";
import { RequireAuth } from "./shell/RequireAuth";
import { Shell } from "./shell/Shell";
import { TITLES } from "./shell/nav";
import { ToastProvider } from "./ui/Toast";

export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route element={<RequireAuth><Shell /></RequireAuth>}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="projects" element={<Projects />} />
          <Route path="new-project" element={<NewProject />} />
          <Route path="home" element={<ProjectHome />} />
          <Route path="project" element={<ProjectSettings />} />
          <Route path="prs" element={<PullRequests />} />
          {Object.keys(TITLES).filter((r) => !["projects", "new-project", "home", "project", "prs"].includes(r)).map((r) => (
            <Route key={r} path={r} element={<Page route={r} />} />
          ))}
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
