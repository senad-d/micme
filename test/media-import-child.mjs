// Isolated worker for the forced-exit storage test. Stay alive at the ASR boundary.
import { MediaImportService } from "../src/transfer/import.ts";

const [path, selected] = process.argv.slice(2);
const service = new MediaImportService(async () => new Promise(() => {}));
const ids = await service.importFiles([path, path], JSON.parse(selected), new AbortController().signal);
console.log(JSON.stringify(ids));
setInterval(() => {}, 1000);
