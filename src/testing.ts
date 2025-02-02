import { Request, Response } from "express";
import http from "node:http";
import { CommonConfig } from "./config-type";
import { AbstractEndpoint } from "./endpoint";
import { AbstractLogger } from "./logger";
import { mimeJson } from "./mime";
import { loadAlternativePeer } from "./peer-helpers";

/**
 * @desc Using module augmentation approach you can set the Mock type of your actual testing framework.
 * @example declare module "express-zod-api" { interface MockOverrides extends Mock {} }
 * @link https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
 * */
export interface MockOverrides {}

/** @desc Compatibility constraints for a function mocking method of a testing framework. */
type MockFunction = (implementation?: (...args: any[]) => any) => MockOverrides;

export const makeRequestMock = <REQ extends Record<string, any>>({
  fnMethod,
  requestProps,
}: {
  fnMethod: MockFunction;
  requestProps?: REQ;
}) =>
  ({
    method: "GET",
    header: fnMethod(() => mimeJson),
    ...requestProps,
  }) as { method: string } & Record<"header", MockOverrides> & REQ;

export const makeResponseMock = <RES extends Record<string, any>>({
  fnMethod,
  responseProps,
}: {
  fnMethod: MockFunction;
  responseProps?: RES;
}) => {
  const responseMock = {
    writableEnded: false,
    statusCode: 200,
    statusMessage: http.STATUS_CODES[200],
    set: fnMethod(() => responseMock),
    setHeader: fnMethod(() => responseMock),
    header: fnMethod(() => responseMock),
    status: fnMethod((code) => {
      responseMock.statusCode = code;
      responseMock.statusMessage = http.STATUS_CODES[code]!;
      return responseMock;
    }),
    json: fnMethod(() => responseMock),
    send: fnMethod(() => responseMock),
    end: fnMethod(() => {
      responseMock.writableEnded = true;
      return responseMock;
    }),
    ...responseProps,
  } as {
    writableEnded: boolean;
    statusCode: number;
    statusMessage: string;
  } & Record<
    "set" | "setHeader" | "header" | "status" | "json" | "send" | "end",
    MockOverrides
  > &
    RES;
  return responseMock;
};

export const makeLoggerMock = <LOG extends Record<string, any>>({
  fnMethod,
  loggerProps,
}: {
  fnMethod: MockFunction;
  loggerProps?: LOG;
}) =>
  ({
    info: fnMethod(),
    warn: fnMethod(),
    error: fnMethod(),
    debug: fnMethod(),
    ...loggerProps,
  }) as Record<keyof AbstractLogger, MockOverrides> & LOG;

interface TestEndpointProps<REQ, RES, LOG> {
  /** @desc The endpoint to test */
  endpoint: AbstractEndpoint;
  /**
   * @desc Additional properties to set on Request mock
   * @default { method: "GET", header: () => "application/json" }
   * */
  requestProps?: REQ;
  /**
   * @desc Additional properties to set on Response mock
   * @default { writableEnded, statusCode, statusMessage, set, setHeader, header, status, json, send, end }
   * */
  responseProps?: RES;
  /**
   * @desc Additional properties to set on config mock
   * @default { cors: false, logger }
   * */
  configProps?: Partial<CommonConfig>;
  /**
   * @desc Additional properties to set on logger mock
   * @default { info, warn, error, debug }
   * */
  loggerProps?: LOG;
  /**
   * @desc Optionally specify the function mocking method of your testing framework
   * @default jest.fn || vi.fn // from vitest
   * @example mock.fn.bind(mock) // from node:test, binding might be necessary
   * */
  fnMethod?: MockFunction;
}

/** @desc Requires either jest (with @types/jest) or vitest or to specify the fnMethod option */
export const testEndpoint = async <
  LOG extends Record<string, any>,
  REQ extends Record<string, any>,
  RES extends Record<string, any>,
>({
  endpoint,
  requestProps,
  responseProps,
  configProps,
  loggerProps,
  fnMethod: userDefined,
}: TestEndpointProps<REQ, RES, LOG>) => {
  const fnMethod =
    userDefined ||
    (
      await loadAlternativePeer<{ fn: MockFunction }>([
        { moduleName: "vitest", moduleExport: "vi" },
        { moduleName: "@jest/globals", moduleExport: "jest" },
      ])
    ).fn;
  const requestMock = makeRequestMock({ fnMethod, requestProps });
  const responseMock = makeResponseMock({ fnMethod, responseProps });
  const loggerMock = makeLoggerMock({ fnMethod, loggerProps });
  const configMock = {
    cors: false,
    logger: loggerMock,
    ...configProps,
  };
  await endpoint.execute({
    request: requestMock as unknown as Request,
    response: responseMock as unknown as Response,
    config: configMock as CommonConfig,
    logger: loggerMock as unknown as AbstractLogger,
  });
  return { requestMock, responseMock, loggerMock };
};
