import React from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App.js";
import { fixtureMapSource } from "./map-sources/fixtures.js";
import { tauriMapSource } from "./map-sources/tauri.js";
import "@xyflow/react/dist/style.css";
import "./style.css";

const root = document.getElementById("root");
if (root === null) throw new Error("The root element is missing.");

createRoot(root).render(
  <React.StrictMode>
    <App mapSource={isTauri() ? tauriMapSource : fixtureMapSource} />
  </React.StrictMode>,
);
