import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function npmVersionChanges(before, after) {
  const paths = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
  return [...paths].sort().flatMap((path) => {
    const oldVersion = before.packages[path]?.version;
    const newVersion = after.packages[path]?.version;
    if (!path.includes("node_modules/") || oldVersion === newVersion) return [];
    return [`- \`${path}\` ${oldVersion ?? "added"} → ${newVersion ?? "removed"}`];
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [before, after] = process.argv.slice(2).map((file) => JSON.parse(readFileSync(file, "utf8")));
  const changes = npmVersionChanges(before, after);
  console.log(changes.length ? changes.join("\n") : "No npm package version changes.");
}
