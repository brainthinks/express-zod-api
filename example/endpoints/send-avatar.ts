import { z } from "../../src";
import { fileSendingEndpointsFactory } from "../factories";
import fs from "fs";

export const sendAvatarEndpoint = fileSendingEndpointsFactory.build({
  methods: ["get"],
  input: z.object({
    userId: z
      .string()
      .regex(/\d+/)
      .transform((str) => parseInt(str, 10)),
  }),
  output: z.object({
    data: z.string(),
  }),
  handler: async () => {
    const data = fs.readFileSync("logo.svg", "utf-8");
    return { data };
  },
});