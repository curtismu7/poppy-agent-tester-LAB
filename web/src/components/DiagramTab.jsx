import { useEffect, useState } from "react";
import PatternDiagram from "./PatternDiagram";
import { getJson } from "../api";

export default function DiagramTab({ resetSignal }) {
  const [pattern, setPattern] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { getJson("/api/diagram?name=poppy-flow").then(setPattern, (e) => setError(e.message)); }, []);
  if (error) return <p className="field-error" role="alert">Could not load the diagram ({error}).</p>;
  if (!pattern) return <p className="muted">Loading...</p>;
  return <PatternDiagram pattern={pattern} resetSignal={resetSignal} />;
}
