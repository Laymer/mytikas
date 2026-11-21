import Zip from "adm-zip";

export const scripts = [
  "Bootstrap.lua",
  "OlympusRecruit.lua",
  "KillOnSight.lua",
  "OlympusMytikas.lua",
];
export const prefix = "OlympusMytikas/";
export function packageZip(version: string, configure?: (zip: Zip) => void) {
  const zip = new Zip();
  zip.addFile(
    prefix + "OlympusMytikas.toc",
    Buffer.from(["## Version: " + version, ...scripts].join("\r\n")),
  );
  for (const script of scripts)
    zip.addFile(prefix + script, Buffer.from("-- Synthetic test fixture"));
  configure?.(zip);
  return zip.toBuffer();
}
