import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Not found</h1>
        <p>That resource does not exist.</p>
      </div>
      <Link href="/research">Back to Research</Link>
    </div>
  );
}
