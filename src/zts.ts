import ts from "typescript";
import { z } from "zod";
import { hasCoercion, tryToTransform } from "./common-helpers";
import { ezDateInKind } from "./date-in-schema";
import { ezDateOutKind } from "./date-out-schema";
import { ezFileKind } from "./file-schema";
import { RawSchema, ezRawKind } from "./raw-schema";
import { HandlingRules, walkSchema } from "./schema-walker";
import {
  LiteralType,
  Producer,
  ZTSContext,
  addJsDocComment,
  makePropertyIdentifier,
} from "./zts-helpers";

const { factory: f } = ts;

const samples = {
  [ts.SyntaxKind.AnyKeyword]: "",
  [ts.SyntaxKind.BigIntKeyword]: BigInt(0),
  [ts.SyntaxKind.BooleanKeyword]: false,
  [ts.SyntaxKind.NumberKeyword]: 0,
  [ts.SyntaxKind.ObjectKeyword]: {},
  [ts.SyntaxKind.StringKeyword]: "",
  [ts.SyntaxKind.UndefinedKeyword]: undefined,
} satisfies Partial<Record<ts.KeywordTypeSyntaxKind, unknown>>;

const onLiteral: Producer<z.ZodLiteral<LiteralType>> = ({
  schema: { value },
}) =>
  f.createLiteralTypeNode(
    typeof value === "number"
      ? f.createNumericLiteral(value)
      : typeof value === "boolean"
        ? value
          ? f.createTrue()
          : f.createFalse()
        : f.createStringLiteral(value),
  );

const onObject: Producer<z.ZodObject<z.ZodRawShape>> = ({
  schema: { shape },
  isResponse,
  next,
  optionalPropStyle: { withQuestionMark: hasQuestionMark },
}) => {
  const members = Object.entries(shape).map<ts.TypeElement>(([key, value]) => {
    const isOptional =
      isResponse && hasCoercion(value)
        ? value instanceof z.ZodOptional
        : value.isOptional();
    const propertySignature = f.createPropertySignature(
      undefined,
      makePropertyIdentifier(key),
      isOptional && hasQuestionMark
        ? f.createToken(ts.SyntaxKind.QuestionToken)
        : undefined,
      next(value),
    );
    if (value.description) {
      addJsDocComment(propertySignature, value.description);
    }
    return propertySignature;
  });
  return f.createTypeLiteralNode(members);
};

const onArray: Producer<z.ZodArray<z.ZodTypeAny>> = ({
  schema: { element },
  next,
}) => f.createArrayTypeNode(next(element));

const onEnum: Producer<z.ZodEnum<[string, ...string[]]>> = ({
  schema: { options },
}) =>
  f.createUnionTypeNode(
    options.map((option) =>
      f.createLiteralTypeNode(f.createStringLiteral(option)),
    ),
  );

const onSomeUnion: Producer<
  | z.ZodUnion<z.ZodUnionOptions>
  | z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>
> = ({ schema: { options }, next }) => f.createUnionTypeNode(options.map(next));

const makeSample = (produced: ts.TypeNode) =>
  samples?.[produced.kind as keyof typeof samples];

const onEffects: Producer<z.ZodEffects<z.ZodTypeAny>> = ({
  schema,
  next,
  isResponse,
}) => {
  const input = next(schema.innerType());
  const effect = schema._def.effect;
  if (isResponse && effect.type === "transform") {
    const outputType = tryToTransform(schema, makeSample(input));
    const resolutions: Partial<
      Record<NonNullable<typeof outputType>, ts.KeywordTypeSyntaxKind>
    > = {
      number: ts.SyntaxKind.NumberKeyword,
      bigint: ts.SyntaxKind.BigIntKeyword,
      boolean: ts.SyntaxKind.BooleanKeyword,
      string: ts.SyntaxKind.StringKeyword,
      undefined: ts.SyntaxKind.UndefinedKeyword,
      object: ts.SyntaxKind.ObjectKeyword,
    };
    return f.createKeywordTypeNode(
      (outputType && resolutions[outputType]) || ts.SyntaxKind.AnyKeyword,
    );
  }
  return input;
};

const onNativeEnum: Producer<z.ZodNativeEnum<z.EnumLike>> = ({ schema }) =>
  f.createUnionTypeNode(
    Object.values(schema.enum).map((value) =>
      f.createLiteralTypeNode(
        typeof value === "number"
          ? f.createNumericLiteral(value)
          : f.createStringLiteral(value),
      ),
    ),
  );

const onOptional: Producer<z.ZodOptional<z.ZodTypeAny>> = ({
  next,
  schema,
  optionalPropStyle: { withUndefined: hasUndefined },
}) => {
  const actualTypeNode = next(schema.unwrap());
  return hasUndefined
    ? f.createUnionTypeNode([
        actualTypeNode,
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
      ])
    : actualTypeNode;
};

const onNullable: Producer<z.ZodNullable<z.ZodTypeAny>> = ({ next, schema }) =>
  f.createUnionTypeNode([
    next(schema.unwrap()),
    f.createLiteralTypeNode(f.createNull()),
  ]);

const onTuple: Producer<z.ZodTuple> = ({
  next,
  schema: {
    items,
    _def: { rest },
  },
}) =>
  f.createTupleTypeNode(
    items
      .map(next)
      .concat(rest === null ? [] : f.createRestTypeNode(next(rest))),
  );

const onRecord: Producer<z.ZodRecord> = ({
  next,
  schema: { keySchema, valueSchema },
}) =>
  f.createExpressionWithTypeArguments(
    f.createIdentifier("Record"),
    [keySchema, valueSchema].map(next),
  );

const onIntersection: Producer<
  z.ZodIntersection<z.ZodTypeAny, z.ZodTypeAny>
> = ({ next, schema }) =>
  f.createIntersectionTypeNode([schema._def.left, schema._def.right].map(next));

const onDefault: Producer<z.ZodDefault<z.ZodTypeAny>> = ({ next, schema }) =>
  next(schema._def.innerType);

const onPrimitive =
  (syntaxKind: ts.KeywordTypeSyntaxKind): Producer<z.ZodTypeAny> =>
  () =>
    f.createKeywordTypeNode(syntaxKind);

const onBranded: Producer<
  z.ZodBranded<z.ZodTypeAny, string | number | symbol>
> = ({ next, schema }) => next(schema.unwrap());

const onReadonly: Producer<z.ZodReadonly<z.ZodTypeAny>> = ({ next, schema }) =>
  next(schema._def.innerType);

const onCatch: Producer<z.ZodCatch<z.ZodTypeAny>> = ({ next, schema }) =>
  next(schema._def.innerType);

const onPipeline: Producer<z.ZodPipeline<z.ZodTypeAny, z.ZodTypeAny>> = ({
  schema,
  next,
  isResponse,
}) => next(schema._def[isResponse ? "out" : "in"]);

const onNull: Producer<z.ZodNull> = () =>
  f.createLiteralTypeNode(f.createNull());

const onLazy: Producer<z.ZodLazy<z.ZodTypeAny>> = ({
  getAlias,
  makeAlias,
  next,
  serializer: serialize,
  schema: lazy,
}) => {
  const name = `Type${serialize(lazy.schema)}`;
  return (
    getAlias(name) ||
    (() => {
      makeAlias(name, f.createLiteralTypeNode(f.createNull())); // make empty type first
      return makeAlias(name, next(lazy.schema)); // update
    })()
  );
};

const onFile: Producer<z.ZodType> = ({ schema }) => {
  const stringType = f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
  const bufferType = f.createTypeReferenceNode("Buffer");
  const unionType = f.createUnionTypeNode([stringType, bufferType]);
  return schema instanceof z.ZodString
    ? stringType
    : schema instanceof z.ZodUnion
      ? unionType
      : bufferType;
};

const onRaw: Producer<RawSchema> = ({ next, schema }) => next(schema.shape.raw);

const producers: HandlingRules<ts.TypeNode, ZTSContext> = {
  ZodString: onPrimitive(ts.SyntaxKind.StringKeyword),
  ZodNumber: onPrimitive(ts.SyntaxKind.NumberKeyword),
  ZodBigInt: onPrimitive(ts.SyntaxKind.BigIntKeyword),
  ZodBoolean: onPrimitive(ts.SyntaxKind.BooleanKeyword),
  ZodAny: onPrimitive(ts.SyntaxKind.AnyKeyword),
  [ezDateInKind]: onPrimitive(ts.SyntaxKind.StringKeyword),
  [ezDateOutKind]: onPrimitive(ts.SyntaxKind.StringKeyword),
  ZodNull: onNull,
  ZodArray: onArray,
  ZodTuple: onTuple,
  ZodRecord: onRecord,
  ZodObject: onObject,
  ZodLiteral: onLiteral,
  ZodIntersection: onIntersection,
  ZodUnion: onSomeUnion,
  ZodDefault: onDefault,
  ZodEnum: onEnum,
  ZodNativeEnum: onNativeEnum,
  ZodEffects: onEffects,
  ZodOptional: onOptional,
  ZodNullable: onNullable,
  ZodDiscriminatedUnion: onSomeUnion,
  ZodBranded: onBranded,
  ZodCatch: onCatch,
  ZodPipeline: onPipeline,
  ZodLazy: onLazy,
  ZodReadonly: onReadonly,
  [ezFileKind]: onFile,
  [ezRawKind]: onRaw,
};

export const zodToTs = ({
  schema,
  ...ctx
}: {
  schema: z.ZodTypeAny;
} & ZTSContext) =>
  walkSchema<ts.TypeNode, ZTSContext>({
    schema,
    rules: producers,
    onMissing: () => f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    ...ctx,
  });
