import {
  isNamedType,
  GraphQLNonNull,
  isOutputType,
  GraphQLFieldConfig,
  GraphQLInputFieldConfigMap,
  GraphQLFieldConfigMap,
  GraphQLFieldConfigArgumentMap,
  GraphQLInputFieldConfig,
  defaultFieldResolver,
  isInputObjectType,
  GraphQLNamedType,
  GraphQLUnionType,
  GraphQLInterfaceType,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLUnionTypeConfig,
  isUnionType,
  isObjectType,
  isInterfaceType,
  isEnumType,
  GraphQLFieldResolver,
  isInputType,
  GraphQLInputType,
  GraphQLList,
} from "graphql";
import * as Types from "./types";
import { GQLiteralTypeWrapper } from "./definitions";
import { NodeType } from "./enums";

const NULL_DEFAULTS = {
  output: false,
  outputList: false,
  outputListItem: false,
  input: true,
  inputList: true,
  inputListItem: false,
};

/**
 * Builds the types, normalizing the "types" passed into the schema for a
 * better developer experience
 */
export function buildTypes(
  types: any[],
  schemaOptions?: Types.SchemaConfig
): Record<string, GraphQLNamedType> {
  const builder = new SchemaBuilder(schemaOptions || {});
  types.forEach((typeDef) => {
    builder.addType(typeDef);
  });
  return builder.getFinalTypeMap();
}

interface BuildConfig {
  union: {
    name: string;
    members: Types.UnionTypeDef[];
    typeConfig: Types.UnionTypeConfig;
  };
  object: {
    name: string;
    fields: Types.FieldDefType[];
    interfaces: string[];
    typeConfig: Types.ObjectTypeConfig;
  };
  input: {
    name: string;
    fields: Types.FieldDefType[];
    typeConfig: Types.InputTypeConfig;
  };
  interface: {
    name: string;
    fields: Types.FieldDefType[];
    typeConfig: Types.UnionTypeConfig;
  };
  enum: {
    name: string;
    members: Types.EnumDefType[];
    typeConfig: Types.EnumTypeConfig;
  };
}

/**
 * Builds all of the types, properly accounts for any using "mix".
 * Since the enum types are resolved synchronously, these need to guard for
 * circular references at this step, while fields will guard for it during lazy evaluation.
 */
export class SchemaBuilder {
  protected buildingTypes: Set<string> = new Set();
  protected finalTypeMap: Record<string, GraphQLNamedType> = {};
  protected pendingTypeMap: Record<string, GQLiteralTypeWrapper<any>> = {};

  constructor(
    protected schemaConfig: Types.Omit<Types.SchemaConfig, "types">
  ) {}

  addType(typeDef: GQLiteralTypeWrapper<any> | GraphQLNamedType) {
    if (this.finalTypeMap[typeDef.name] || this.pendingTypeMap[typeDef.name]) {
      throw new Error(`Named type ${typeDef.name} declared more than once`);
    }
    if (isNamedType(typeDef)) {
      this.finalTypeMap[typeDef.name] = typeDef;
    } else {
      this.pendingTypeMap[typeDef.name] = typeDef;
    }
  }

  getFinalTypeMap(): Record<string, GraphQLNamedType> {
    Object.keys(this.pendingTypeMap).forEach((key) => {
      // If we've already constructed the type by this point,
      // via circular dependency resolution don't worry about building it.
      if (this.finalTypeMap[key]) {
        return;
      }
      this.finalTypeMap[key] = this.getOrBuildType(key);
      this.buildingTypes.clear();
    });
    return {};
  }

  inputObjectType(config: BuildConfig["input"]): GraphQLInputObjectType {
    const { name, fields, typeConfig } = config;
    return new GraphQLInputObjectType({
      name,
      fields: () => this.buildInputObjectFields(name, fields),
      description: config.typeConfig.description,
    });
  }

  objectType(config: BuildConfig["object"]) {
    const { fields, interfaces, name, typeConfig } = config;
    return new GraphQLObjectType({
      name,
      interfaces: () => interfaces.map((i) => this.getInterface(i)),
      fields: () => this.buildObjectFields(name, fields, typeConfig),
    });
  }

  interfaceType(config: BuildConfig["interface"]) {
    let description;
    const { name, fields, typeConfig } = config;
    return new GraphQLInterfaceType({
      name,
      fields: () => this.buildObjectFields(name, fields, typeConfig),
      resolveType: typeConfig.resolveType,
      description,
      // astNode?: Maybe<InterfaceTypeDefinitionNode>;
      // extensionASTNodes?: Maybe<ReadonlyArray<InterfaceTypeExtensionNode>>;
    });
  }

  enumType(config: BuildConfig["enum"]) {
    const { name, typeConfig, members } = config;
    let values: GraphQLEnumValueConfigMap = {},
      description;
    config.members.forEach((member) => {
      switch (member.item) {
        case Types.NodeType.ENUM_MEMBER:
          values[member.info.name] = {
            value: member.info.value,
            description: member.info.description,
          };
          break;
        case Types.NodeType.MIX:
          const { pick, omit } = member.mixOptions;
          enumToMix.getValues().forEach((val) => {
            if (pick && pick.indexOf(val.name) === -1) {
              return;
            }
            if (omit && omit.indexOf(val.name) !== -1) {
              return;
            }
            values[val.name] = {
              description: val.description,
              deprecationReason: val.deprecationReason,
              value: val.value,
              astNode: val.astNode,
            };
          });
          break;
      }
    });
    if (Object.keys(values).length === 0) {
      throw new Error(
        `GQLiteralEnum ${this.name} must have at least one member`
      );
    }
    return new GraphQLEnumType({
      name,
      values,
      description,
    });
  }

  unionType(config: BuildConfig["union"]) {
    return new GraphQLUnionType({
      name: config.name,
      types: () => {
        return config.members.reduce((result: GraphQLObjectType[], member) => {
          switch (member.item) {
            case Types.NodeType.MIX:
              break;
            case Types.NodeType.UNION_MEMBER:
              const type = this.getOrBuildType(member.typeName);
              if (!isObjectType(type)) {
                throw new Error(
                  `Expected ${member.typeName} to be an ObjectType, saw ${
                    type.constructor.name
                  }`
                );
              }
              return result.concat(type);
          }
          return result;
        }, []);
      },
      resolveType: config.typeConfig,
    });
  }

  protected missingType(typeName: string): GraphQLNamedType {
    const suggestions = suggestionList(
      typeName,
      Object.keys(this.buildingTypes).concat(Object.keys(this.finalTypeMap))
    );
    let suggestionsString = "";
    if (suggestions.length > 0) {
      suggestionsString = ` or mean ${suggestions.join(", ")}`;
    }
    throw new Error(
      `Missing type ${typeName}, did you forget to import a type${suggestionsString}?`
    );
  }

  protected buildObjectFields(
    typeName: string,
    fields: Types.FieldDefType[],
    typeConfig: Types.ObjectTypeConfig
  ): GraphQLFieldConfigMap<any, any> {
    const fieldMap: GraphQLFieldConfigMap<any, any> = {};
    fields.forEach((field) => {
      switch (field.item) {
        case Types.NodeType.MIX:
        case Types.NodeType.MIX_ABSTRACT:
          throw new Error("TODO");
          break;
        case Types.NodeType.FIELD:
          fieldMap[field.fieldName] = this.buildObjectField(field, typeConfig);
          break;
      }
    });
    return fieldMap;
  }

  protected buildObjectField(
    field: Types.FieldDef,
    typeConfig: Types.ObjectTypeConfig
  ): GraphQLFieldConfig<any, any> {
    return {
      type: this.getOutputType(field.fieldType),
      resolve: this.getResolver(field.fieldOptions, typeConfig),
      description: typeConfig.description,
      args: this.buildArgs(field.fieldOptions.args || {}, typeConfig),
      // subscribe?: GraphQLFieldResolver<TSource, TContext, TArgs>;
      // deprecationReason?: Maybe<string>;
      // description?: Maybe<string>;
      // astNode?: Maybe<FieldDefinitionNode>;
    };
  }

  protected buildInputObjectFields(
    typeName: string,
    fields: Types.FieldDefType[]
  ): GraphQLInputFieldConfigMap {
    return {};
  }

  protected buildInputObjectField(): GraphQLInputFieldConfig<any, any> {
    return {};
  }

  protected buildArgs(
    args: Types.OutputFieldArgs,
    typeConfig: Types.InputTypeConfig
  ): GraphQLFieldConfigArgumentMap {
    const allArgs: GraphQLFieldConfigArgumentMap = {};
    Object.keys(allArgs).forEach((argName) => {
      const argDef = args[argName];
      allArgs[argName] = {
        type: this.decorateInputType(
          this.getInputType(argDef.type),
          argDef,
          typeConfig
        ),
        description: argDef.description,
      };
    });
    return {};
  }

  protected decorateOutputType(
    type: GraphQLInputType,
    typeOpts: Types.FieldOpts,
    typeConfig: Types.ObjectTypeConfig
  ) {
    return this.decorateType(type, typeOpts, typeConfig, false);
  }

  protected decorateInputType(
    type: GraphQLInputType,
    argOpts: Types.ArgOpts,
    typeConfig: Types.InputTypeConfig
  ) {
    const { required: _required, requiredListItem, ...rest } = argOpts;
    const newOpts = rest;
    if (typeof _required !== "undefined") {
      newOpts.nullable = !_required;
    }
    if (typeof requiredListItem !== "undefined") {
      if (rest.list) {
        newOpts.listItemNullable = !requiredListItem;
      }
    }
    return this.decorateType(type, newOpts, typeConfig, true);
  }

  /**
   * Adds the null / list configuration to the type.
   */
  protected decorateType(
    type: GraphQLInputType,
    fieldOpts: Types.FieldOpts,
    typeConfig: Types.ObjectTypeConfig,
    isInput: boolean
  ): GraphQLInputType {
    let finalType = type;
    const nullConfig = {
      ...NULL_DEFAULTS,
      ...this.schemaConfig.nullabilityConfig,
      ...typeConfig.nullabilityConfig,
    };
    const { list, nullable, listItemNullable } = fieldOpts;
    const isNullable =
      typeof nullable !== "undefined"
        ? nullable
        : list
          ? isInput
            ? nullConfig.inputList
            : nullConfig.outputList
          : isInput
            ? nullConfig.input
            : nullConfig.output;

    // TODO: Figure out how lists of lists will be represented.
    if (list) {
      const nullableItem =
        typeof listItemNullable !== "undefined"
          ? listItemNullable
          : isInput
            ? nullConfig.inputListItem
            : nullConfig.outputListItem;
      if (nullableItem) {
        finalType = GraphQLNonNull(finalType);
      }
      finalType = GraphQLList(finalType);
    } else if (typeof listItemNullable !== "undefined") {
      console.log(
        "listItemNullable should only be set with list: true, this option is ignored"
      );
    }

    if (isNullable) {
      return GraphQLNonNull(finalType);
    }
    return finalType;
  }

  protected getInterface(name: string): GraphQLInterfaceType {
    const type = this.getOrBuildType(name);
    if (!isInterfaceType(type)) {
      throw new Error(
        `Expected ${name} to be a GraphQLInterfaceType, saw ${
          type.constructor.name
        }`
      );
    }
    return type;
  }

  protected getEnum(name: string): GraphQLEnumType {
    const type = this.getOrBuildType(name);
    if (!isEnumType(type)) {
      throw new Error(
        `Expected ${name} to be a GraphQLEnumType, saw ${type.constructor.name}`
      );
    }
    return type;
  }

  protected getUnion(name: string): GraphQLUnionType {
    const type = this.getOrBuildType(name);
    if (!isUnionType(type)) {
      throw new Error(
        `Expected ${name} to be a GraphQLUnionType, saw ${
          type.constructor.name
        }`
      );
    }
    return type;
  }

  protected getInputType(name: string) {
    const type = this.getOrBuildType(name);
    if (!isInputType(type)) {
      throw new Error(
        `Expected ${name} to be a valid input type, saw ${
          type.constructor.name
        }`
      );
    }
    return type;
  }

  protected getOutputType(name: string) {
    const type = this.getOrBuildType(name);
    if (!isOutputType(type)) {
      throw new Error(
        `Expected ${name} to be a valid output type, saw ${
          type.constructor.name
        }`
      );
    }
    return type;
  }

  protected getObjectType(name: string) {
    const type = this.getOrBuildType(name);
    if (!isObjectType(type)) {
      throw new Error(
        `Expected ${name} to be a GraphQLObjectType, saw ${
          type.constructor.name
        }`
      );
    }
    return type;
  }

  protected getOrBuildType(name: string): GraphQLNamedType {
    if (this.finalTypeMap[name]) {
      return this.finalTypeMap[name];
    }
    if (this.buildingTypes.has(name)) {
      throw new Error(
        `GQLiteral: Circular dependency detected, while building types ${Array.from(
          this.buildingTypes
        )}`
      );
    }
    const pendingType = this.pendingTypeMap[name];
    if (pendingType) {
      this.buildingTypes.add(name);
      return pendingType.type.buildType(name, this);
    }
    return this.missingType(name);
  }

  protected getResolver(
    fieldOptions: Types.OutputFieldOpts,
    typeConfig: Types.ObjectTypeConfig
  ) {
    if (fieldOptions.resolve) {
      if (typeof fieldOptions.property !== "undefined") {
        console.warn(
          `Both resolve and property should not be supplied, property will be ignored`
        );
      }
      return fieldOptions.resolve;
    }
    if (fieldOptions.property) {
      return propertyFieldResolver(fieldOptions.property);
    }
    if (typeConfig.defaultResolver) {
      return typeConfig.defaultResolver;
    }
    if (this.schemaConfig.defaultResolver) {
      return this.schemaConfig.defaultResolver;
    }
    return defaultFieldResolver;
  }
}

export function withDeprecationComment(description?: string | null) {
  return description;
}

export const enumShorthandMembers = (
  arg: string[] | Record<string, string | number | object | boolean>
): Types.EnumMemberInfo[] => {
  if (Array.isArray(arg)) {
    return arg.map((name) => ({ name, value: name }));
  }
  return Object.keys(arg).map((name) => {
    return {
      name,
      value: arg[name],
    };
  });
};

/**
 * If a resolve function is not given, then a default resolve behavior is used
 * which takes the property of the source object of the same name as the field
 * and returns it as the result, or if it's a function, returns the result
 * of calling that function while passing along args and context value.
 */
export const propertyFieldResolver = (
  key: string
): GraphQLFieldResolver<any, any> =>
  function(source, args, contextValue, info) {
    // ensure source is a value for which property access is acceptable.
    if (typeof source === "object" || typeof source === "function") {
      // TODO: Maybe warn here if key doesn't exist on source?
      const property = source[key];
      if (typeof property === "function") {
        return source[key](args, contextValue, info);
      }
      return property;
    }
  };

// ----------------------------

/**
 *
 * Copied from graphql-js:
 *
 */

/**
 * Given an invalid input string and a list of valid options, returns a filtered
 * list of valid options sorted based on their similarity with the input.
 */
export default function suggestionList(
  input: string,
  options: string[]
): string[] {
  var optionsByDistance = Object.create(null);
  var oLength = options.length;
  var inputThreshold = input.length / 2;

  for (var i = 0; i < oLength; i++) {
    var distance = lexicalDistance(input, options[i]);
    var threshold = Math.max(inputThreshold, options[i].length / 2, 1);

    if (distance <= threshold) {
      optionsByDistance[options[i]] = distance;
    }
  }

  return Object.keys(optionsByDistance).sort(function(a, b) {
    return optionsByDistance[a] - optionsByDistance[b];
  });
}
/**
 * Computes the lexical distance between strings A and B.
 *
 * The "distance" between two strings is given by counting the minimum number
 * of edits needed to transform string A into string B. An edit can be an
 * insertion, deletion, or substitution of a single character, or a swap of two
 * adjacent characters.
 *
 * Includes a custom alteration from Damerau-Levenshtein to treat case changes
 * as a single edit which helps identify mis-cased values with an edit distance
 * of 1.
 *
 * This distance can be useful for detecting typos in input or sorting
 */
function lexicalDistance(aStr: string, bStr: string): number {
  if (aStr === bStr) {
    return 0;
  }

  var i;
  var j;
  var d = [];
  var a = aStr.toLowerCase();
  var b = bStr.toLowerCase();
  var aLength = a.length;
  var bLength = b.length; // Any case change counts as a single edit

  if (a === b) {
    return 1;
  }

  for (i = 0; i <= aLength; i++) {
    d[i] = [i];
  }

  for (j = 1; j <= bLength; j++) {
    d[0][j] = j;
  }

  for (i = 1; i <= aLength; i++) {
    for (j = 1; j <= bLength; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }

  return d[aLength][bLength];
}