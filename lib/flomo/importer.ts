import * as path from 'path';
import * as os from 'os';
import *  as fs from 'fs-extra';

import { App } from 'obsidian';
import decompress from 'decompress';
import * as parse5 from "parse5"

import { FlomoCore } from './core';
import { generateMoments } from '../obIntegration/moments';
import { generateCanvas } from '../obIntegration/canvas';

import { FLOMO_CACHE_LOC } from './const'
//const FLOMO_CACHE_LOC = path.join(os.homedir(), "/.flomo/cache/");


export class FlomoImporter {
    private config: Record<string, any>;
    private app: App;

    constructor(app: App, config: Record<string, string>) {
        this.config = config;
        this.app = app;
        this.config["baseDir"] = app.vault.adapter.basePath;
    }

    private async sanitize(path: string): Promise<string> {
        const flomoData = await fs.readFile(path, "utf8");
        const document = parse5.parse(flomoData);
        return parse5.serialize(document);
    }

    private async importMemos(flomo: FlomoCore): Promise<FlomoCore> {
        const allowBilink: boolean = this.config["expOptionAllowbilink"];
        const margeByDate: boolean = this.config["mergeByDate"];

        for (const [idx, memo] of flomo.memos.entries()) {

            const memoSubDir = `${this.config["flomoTarget"]}/${this.config["memoTarget"]}/${memo["date"]}`;
            const memoFilePath = margeByDate ? `${memoSubDir}/memo@${memo["date"]}.md` : `${memoSubDir}/memo@${memo["title"]}_${flomo.memos.length - idx}.md`;

            await fs.mkdirp(`${this.config["baseDir"]}/${memoSubDir}`);
            const content = (() => {
                // @Mar-31, 2024 Fix: #20 - Support <mark>.*?<mark/>
                // Break it into 2 stages, too avoid "==" translating to "\=="
                //  1. Replace <mark> & </mark> with FLOMOIMPORTERHIGHLIGHTMARKPLACEHOLDER (in lib/flomo/core.ts)
                //  2. Replace FLOMOIMPORTERHIGHLIGHTMARKPLACEHOLDER with ==
                const res = memo["content"].replaceAll("FLOMOIMPORTERHIGHLIGHTMARKPLACEHOLDER", "==");

                if (allowBilink == true) {
                    return res.replace(`\\[\\[`, "[[").replace(`\\]\\]`, "]]");
                }

                return res;

            })();

            if (!(memoFilePath in flomo.files)) {
                flomo.files[memoFilePath] = []
            }

            flomo.files[memoFilePath].push(content);
        }

        const attachmentPrefix = `${this.config["flomoTarget"]}/file/`;
        for (const filePath in flomo.files) {
            const content = flomo.files[filePath]
                .join("\n\n---\n\n")
                .replace(/!\[\]\(file\//gi, `![](${attachmentPrefix}`);
            await this.app.vault.adapter.write(
                filePath,
                content
            );
        }

        return flomo;
    }

    async import(): Promise<FlomoCore> {

        // 1. Create workspace
        const tmpDir = path.join(FLOMO_CACHE_LOC, "data")
        await fs.mkdirp(tmpDir);

        // 2. Unzip flomo_backup.zip to workspace
        const files = await decompress(this.config["rawDir"], tmpDir)

        // 3. copy attachments to <vault>/<flomoTarget>/file/
        const attachmentTargetDir = `${this.config["flomoTarget"]}/file/`;
        await fs.mkdirp(`${this.config["baseDir"]}/${attachmentTargetDir}`);

        for (const f of files) {
            if (f.type == "directory" && f.path.endsWith("/file/")) {
                console.debug(`DEBUG: copying from ${tmpDir}/${f.path} to ${this.config["baseDir"]}/${attachmentTargetDir}`)
                await fs.copy(`${tmpDir}/${f.path}`, `${this.config["baseDir"]}/${attachmentTargetDir}`);
                break
            }

        }

        // 4. Import Memos
        // @Mar-31, 2024 Fix: #21 - Update default page from index.html to <userid>.html
        const defaultPage = (await fs.readdir(`${tmpDir}/${files[0].path}`)).filter((fn, _idx, fn_array) => fn.endsWith('.html'))[0];
        const dataExport = await this.sanitize(`${tmpDir}/${files[0].path}/${defaultPage}`);
        const flomo = new FlomoCore(dataExport);

        const memos = await this.importMemos(flomo);

        // 5. Ob Intergations
        // If Generate Moments
        if (this.config["optionsMoments"] != "skip") {
            await generateMoments(this.app, memos, this.config);
        }


        // If Generate Canvas
        if (this.config["optionsCanvas"] != "skip") {
            await generateCanvas(this.app, memos, this.config);
        }


        // 6. Cleanup Workspace
        await fs.remove(tmpDir);

        return flomo

    }

}
