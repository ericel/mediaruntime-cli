import { spawn } from "node:child_process";
import { CliError } from "../errors.js";

export async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? { executable: "open", args: [url] }
    : process.platform === "win32"
      ? { executable: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
      : { executable: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => reject(new CliError(
      "browser_open_failed",
      "Could not open a browser; rerun with --no-browser and open the printed URL",
      2,
      { cause: error },
    )));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
