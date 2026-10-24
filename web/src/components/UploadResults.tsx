import { Link } from "react-router-dom";
import type { Result } from "../lib/uploads";

/** Progress of uploaded photos / PDFs, each linking to its receipt once read. */
export function UploadResults({ results }: { results: Result[] }) {
  if (!results.length) return null;
  return (
    <ul className="results">
      {results.map((r, i) => (
        <li key={i} className={r.state}>
          <span className="name">{r.name}</span>
          <span>{r.state === "working" && "⏳ "}{r.text}</span>
          {r.receiptId && <Link to={`/receipts/${r.receiptId}`}>Open</Link>}
        </li>
      ))}
    </ul>
  );
}
