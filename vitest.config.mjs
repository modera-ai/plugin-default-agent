import { fileURLToPath } from "node:url";
export default {
  test: {
    include: [
      fileURLToPath(
        new URL("./tests/**/*.test.ts", import.meta.url),
      ).replaceAll("\\", "/"),
    ],
    fileParallelism: false,
  },
};
