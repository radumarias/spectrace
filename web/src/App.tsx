import { Navigate, Route, Routes } from "react-router-dom";
import { Page } from "./pages/Page";
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
          {Object.keys(TITLES).map((r) => (
            <Route key={r} path={r} element={<Page route={r} />} />
          ))}
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
