import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell.js";
import "./index.css";
import { Iteration } from "./routes/Iteration.js";
import { Live } from "./routes/Live.js";
import { Reports } from "./routes/Reports.js";
import { System } from "./routes/System.js";

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Live /> },
      { path: "reports", element: <Reports /> },
      // The run sheet is a search param rather than a nested route, so it can
      // open over the live matrix and over a finished report alike.
      { path: "reports/:slug", element: <Iteration /> },
      { path: "system", element: <System /> },
    ],
  },
]);

const root = document.getElementById("root");
if (root === null) throw new Error("no #root to mount into");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
