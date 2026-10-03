import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "@xyflow/react/dist/style.css";
import "./style.css";

const root = document.getElementById("root");
if (root === null) throw new Error("The root element is missing.");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
