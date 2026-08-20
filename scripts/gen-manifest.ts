/**
 * Generates the CLI command manifest from the installed `cloudflare` SDK.
 *
 * It walks the SDK's TypeScript declarations (type checker) to discover the
 * resource tree, every method, its positional arguments, its params shape
 * (flattened to CLI flags) and pagination/return info. The compiled JS is
 * parsed as well to recover the HTTP verb + path template of every method.
 *
 * Output: src/generated/manifest.json  (+ src/generated/modules.ts)
 *
 * Run: bun run gen
 */
import ts from 'ts5';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { kebab, normKey } from '../src/core/names';
import type {
  HttpMethod,
  Manifest,
  MethodNode,
  ParamProp,
  ParamLocation,
  Positional,
  ResourceNode,
  TypeSpec,
} from '../src/core/manifest-types';

const ROOT = resolve(import.meta.dir, '..');
const CF_DIR = resolve(ROOT, 'node_modules/cloudflare');
const OUT_DIR = resolve(ROOT, 'src/generated');
const MAX_DEPTH = 3;

const sdkPkg = JSON.parse(readFileSync(join(CF_DIR, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return (m?.[1] ?? t).slice(0, 200);
}

function cleanDoc(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

// ---------------------------------------------------------------------------
// JS parsing: recover HTTP verb/path/multipart/binary info per method
// ---------------------------------------------------------------------------

interface JsMethodInfo {
  http?: HttpMethod;
  path?: string;
  multipart?: boolean;
  binary?: boolean;
  pageClass?: string;
}

const jsCache = new Map<string, Map<string, JsMethodInfo>>();

function jsInfoForFile(dtsFile: string): Map<string, JsMethodInfo> {
  const jsFile = dtsFile.replace(/\.d\.ts$/, '.js');
  const cached = jsCache.get(jsFile);
  if (cached) return cached;
  const map = new Map<string, JsMethodInfo>();
  jsCache.set(jsFile, map);
  if (!existsSync(jsFile)) return map;
  const src = readFileSync(jsFile, 'utf8');
  const sf = ts.createSourceFile(jsFile, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);

  const visitClass = (cls: ts.ClassLikeDeclaration) => {
    const clsName = cls.name?.text ?? '';
    const isBase = clsName.startsWith('Base');
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      const name = member.name.getText(sf);
      const info: JsMethodInfo = {};
      const text = member.body.getText(sf);
      if (/multipartFormRequestOptions|maybeMultipartFormRequestOptions/.test(text)) info.multipart = true;
      if (/__binaryResponse:\s*true/.test(text)) info.binary = true;
      const walk = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const calleeText = n.expression.getText(sf);
          const m = calleeText.match(/^this\._client\.(get|post|put|patch|delete|getAPIList)$/);
          if (m && !info.http) {
            const verb = m[1]!;
            info.http = (verb === 'getAPIList' ? 'GET' : verb.toUpperCase()) as HttpMethod;
            const arg0 = n.arguments[0];
            if (arg0) info.path = templateToPath(arg0, sf);
            if (verb === 'getAPIList') {
              const arg1 = n.arguments[1];
              if (arg1) {
                const t = arg1.getText(sf).replace(/[()\s]/g, '');
                info.pageClass = t.split('.').pop();
              }
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(member.body);
      // Prefer the non-Base (customized) class implementation if both exist.
      if (!map.has(name) || !isBase) map.set(name, info);
    }
  };

  const walkTop = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) visitClass(n);
    ts.forEachChild(n, walkTop);
  };
  walkTop(sf);
  return map;
}

function templateToPath(node: ts.Expression, sf: ts.SourceFile): string | undefined {
  let tpl: ts.Node = node;
  if (ts.isTaggedTemplateExpression(tpl)) tpl = tpl.template;
  if (ts.isNoSubstitutionTemplateLiteral(tpl) || ts.isStringLiteral(tpl)) return tpl.text;
  if (ts.isTemplateExpression(tpl)) {
    let out = tpl.head.text;
    for (const span of tpl.templateSpans) {
      out += `{${span.expression.getText(sf).trim()}}` + span.literal.text;
    }
    return out;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Type checker setup
// ---------------------------------------------------------------------------

const clientDts = join(CF_DIR, 'client.d.ts');
const program = ts.createProgram([clientDts], {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
  strict: true,
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
});
const checker = program.getTypeChecker();
const clientSf = program.getSourceFile(clientDts);
if (!clientSf) throw new Error('client.d.ts not found');

let clientClass: ts.ClassDeclaration | undefined;
clientSf.forEachChild((n) => {
  if (ts.isClassDeclaration(n) && n.name?.text === 'Cloudflare') clientClass = n;
});
if (!clientClass) throw new Error('Cloudflare class not found');

// ---------------------------------------------------------------------------
// Type description
// ---------------------------------------------------------------------------

function isUploadable(t: ts.Type): boolean {
  if (t.aliasSymbol?.name === 'Uploadable') return true;
  const name = t.symbol?.name;
  return name === 'File' || name === 'Blob' || name === 'FsReadStream' || name === 'BunFile';
}

function stripNullish(t: ts.Type): { type: ts.Type; nullable: boolean } {
  if (!t.isUnion()) return { type: t, nullable: false };
  const members = t.types.filter((m) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
  const nullable = members.length !== t.types.length;
  if (members.length === t.types.length) return { type: t, nullable: false };
  if (members.length === 1) return { type: members[0]!, nullable };
  // Re-derive a union: the checker has no public API to build unions, so we
  // describe members individually downstream. We return the original type but
  // flag nullable; callers handle unions by iterating `types` and skipping nullish.
  return { type: t, nullable };
}

function unionMembers(t: ts.Type): ts.Type[] {
  if (!t.isUnion()) return [t];
  return t.types.filter((m) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
}

function typeText(t: ts.Type): string {
  const s = checker.typeToString(
    t,
    undefined,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

function isObjectLike(t: ts.Type): boolean {
  if (!(t.flags & ts.TypeFlags.Object)) return false;
  if (checker.isArrayType(t) || checker.isTupleType(t)) return false;
  return true;
}

function describeType(t: ts.Type, depth: number, seen: Set<number>): TypeSpec {
  const members = unionMembers(t);
  const nullable = members.length !== (t.isUnion() ? t.types.length : 1);

  if (members.length === 0) return { kind: 'json', text: typeText(t) };

  // Literal unions -> enum
  const allStringLit = members.every((m) => m.isStringLiteral());
  const allNumLit = members.every((m) => m.isNumberLiteral());
  const allBoolLit = members.every((m) => m.flags & ts.TypeFlags.BooleanLiteral);
  if (allStringLit) {
    return { kind: 'enum', enum: members.map((m) => (m as ts.StringLiteralType).value), nullable: nullable || undefined };
  }
  if (allNumLit) {
    return { kind: 'enum', enum: members.map((m) => (m as ts.NumberLiteralType).value), nullable: nullable || undefined };
  }
  if (allBoolLit) return { kind: 'boolean', nullable: nullable || undefined };

  if (members.length === 1) {
    const m = members[0]!;
    if (m.flags & ts.TypeFlags.String) return { kind: 'string', nullable: nullable || undefined };
    if (m.flags & ts.TypeFlags.Number) return { kind: 'number', nullable: nullable || undefined };
    if (m.flags & ts.TypeFlags.Boolean) return { kind: 'boolean', nullable: nullable || undefined };
    if (m.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: 'json', text: 'unknown' };
    if (isUploadable(m)) return { kind: 'file' };
    if (checker.isArrayType(m) || checker.isTupleType(m)) {
      const args = checker.getTypeArguments(m as ts.TypeReference);
      const item = args[0] ? describeType(args[0], depth + 1, seen) : { kind: 'json' as const };
      return { kind: 'array', items: item, nullable: nullable || undefined };
    }
    if (isObjectLike(m)) {
      const props = m.getProperties();
      const idx = checker.getIndexInfosOfType(m);
      if (props.length === 0 && idx.length > 0) {
        return { kind: 'record', text: typeText(m), nullable: nullable || undefined };
      }
      if (props.length === 0) return { kind: 'json', text: typeText(m) };
      const id = (m as any).id as number | undefined;
      if (depth >= MAX_DEPTH || (id !== undefined && seen.has(id))) {
        return { kind: 'object', text: typeText(m), nullable: nullable || undefined };
      }
      const nextSeen = new Set(seen);
      if (id !== undefined) nextSeen.add(id);
      return {
        kind: 'object',
        text: typeText(m),
        props: props.map((p) => describeProp(p, depth + 1, nextSeen)),
        nullable: nullable || undefined,
      };
    }
    return { kind: 'json', text: typeText(m) };
  }

  // Heterogeneous union
  const objMembers = members.filter((m) => isObjectLike(m) && !isUploadable(m));
  if (objMembers.length === members.length) {
    // Union of objects: merge props (required only if required everywhere).
    const merged = mergeObjectUnion(objMembers, depth, seen);
    return { ...merged, nullable: nullable || undefined };
  }
  if (members.some(isUploadable)) return { kind: 'file' };
  const memberSpecs = members.map((m) => describeType(m, depth + 1, seen));
  // Collapse simple cases
  const kinds = new Set(memberSpecs.map((s) => s.kind));
  if (kinds.size === 1 && kinds.has('string')) return { kind: 'string' };
  if (kinds.size === 1 && kinds.has('number')) return { kind: 'number' };
  return { kind: 'union', members: memberSpecs, text: typeText(t), nullable: nullable || undefined };
}

function mergeObjectUnion(objMembers: ts.Type[], depth: number, seen: Set<number>): TypeSpec {
  if (depth >= MAX_DEPTH) return { kind: 'object', text: objMembers.map(typeText).join(' | ') };
  const propMap = new Map<string, { prop: ParamProp; count: number }>();
  for (const m of objMembers) {
    const id = (m as any).id as number | undefined;
    if (id !== undefined && seen.has(id)) continue;
    const nextSeen = new Set(seen);
    if (id !== undefined) nextSeen.add(id);
    for (const p of m.getProperties()) {
      const desc = describeProp(p, depth + 1, nextSeen);
      const existing = propMap.get(desc.name);
      if (!existing) {
        propMap.set(desc.name, { prop: desc, count: 1 });
      } else {
        existing.count++;
        // merge enums
        const a = existing.prop.type;
        const b = desc.type;
        if (a.kind === 'enum' && b.kind === 'enum') {
          const set = new Set([...(a.enum ?? []), ...(b.enum ?? [])]);
          a.enum = [...set];
        } else if (a.kind !== b.kind && a.kind !== 'union') {
          existing.prop.type = { kind: 'union', members: [a, b], text: `${a.text ?? a.kind} | ${b.text ?? b.kind}` };
        }
        if (!existing.prop.description && desc.description) existing.prop.description = desc.description;
        existing.prop.required = existing.prop.required && desc.required;
      }
    }
  }
  const props = [...propMap.values()].map(({ prop, count }) => {
    if (count < objMembers.length) prop.required = false;
    return prop;
  });
  return { kind: 'object', text: objMembers.map(typeText).join(' | '), props, variants: objMembers.length };
}

function describeProp(p: ts.Symbol, depth: number, seen: Set<number>): ParamProp {
  const decl = p.valueDeclaration ?? p.declarations?.[0];
  const t = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getDeclaredTypeOfSymbol(p);
  const optional = !!(p.flags & ts.SymbolFlags.Optional);
  let doc = cleanDoc(ts.displayPartsToString(p.getDocumentationComment(checker)));
  let location: ParamLocation | undefined;
  const lm = doc.match(/^(Path|Query|Body|Header) param:?\s*/i);
  if (lm) {
    location = lm[1]!.toLowerCase() as ParamLocation;
    doc = doc.slice(lm[0].length).trim();
  }
  const tags = p.getJsDocTags(checker);
  const deprecated = tags.some((tg) => tg.name === 'deprecated');
  const spec = describeType(t, depth, seen);
  const out: ParamProp = {
    name: p.name,
    required: !optional,
    type: spec,
  };
  if (location) out.location = location;
  if (doc) out.description = doc.length > 600 ? doc.slice(0, 597) + '...' : doc;
  if (deprecated) out.deprecated = true;
  return out;
}

// ---------------------------------------------------------------------------
// Resource tree walk
// ---------------------------------------------------------------------------

function isResourceType(t: ts.Type): boolean {
  if (!(t.flags & ts.TypeFlags.Object)) return false;
  const sym = t.getSymbol();
  if (!sym || !(sym.flags & ts.SymbolFlags.Class)) return false;
  return !!checker.getPropertyOfType(t, '_client');
}

function moduleOf(sym: ts.Symbol): string {
  const decl = sym.declarations?.[0];
  if (!decl) throw new Error(`no declaration for ${sym.name}`);
  const file = decl.getSourceFile().fileName;
  const rel = relative(CF_DIR, file).replace(/\\/g, '/');
  return rel.replace(/\.d\.ts$/, '');
}

let methodCount = 0;
let resourceCount = 0;
const stats = { noHttp: 0, deprecated: 0, paginated: 0, multipart: 0, binary: 0 };

function buildMethod(name: string, sym: ts.Symbol, ownerType: ts.Type): MethodNode | undefined {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl) return undefined;
  const mt = checker.getTypeOfSymbolAtLocation(sym, decl);
  const sigs = checker.getSignaturesOfType(mt, ts.SignatureKind.Call);
  if (sigs.length === 0) return undefined;
  // Prefer the signature with the most parameters (covers optional-params overloads).
  const sig = [...sigs].sort((a, b) => b.getParameters().length - a.getParameters().length)[0]!;

  const doc = cleanDoc(ts.displayPartsToString(sym.getDocumentationComment(checker)));
  const tags = sym.getJsDocTags(checker);
  const deprecated = tags.some((t) => t.name === 'deprecated');
  const deprecatedNote = tags.find((t) => t.name === 'deprecated');

  const positionals: Positional[] = [];
  let params: MethodNode['params'];

  for (const p of sig.getParameters()) {
    const pdecl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
    const pt = pdecl ? checker.getTypeOfSymbolAtLocation(p, pdecl) : checker.getDeclaredTypeOfSymbol(p);
    const optional = pdecl ? checker.isOptionalParameter(pdecl) : false;
    const pname = p.name;
    if (pname === 'options' || pt.aliasSymbol?.name === 'RequestOptions' || typeText(pt).includes('RequestOptions')) {
      continue;
    }
    const members = unionMembers(pt);
    const objectish = members.length > 0 && members.every((m) => isObjectLike(m) && !isUploadable(m));
    if (pname === 'params' || pname === 'body' || pname === 'query' || (objectish && !positionalLike(members))) {
      const spec = describeType(pt, 0, new Set());
      params = {
        name: pname,
        required: !optional,
        type: spec,
      };
    } else {
      const spec = describeType(pt, 1, new Set());
      positionals.push({
        name: pname,
        cli: kebab(pname),
        type: spec.kind === 'number' ? 'number' : spec.kind === 'enum' ? 'enum' : 'string',
        enum: spec.kind === 'enum' ? (spec.enum as string[]) : undefined,
        required: !optional,
        description: cleanDoc(ts.displayPartsToString(p.getDocumentationComment(checker))) || undefined,
      });
    }
  }

  // Return / pagination
  const rt = checker.getReturnTypeOfSignature(sig);
  let paginated: string | undefined;
  let returns: string | undefined;
  const rtName = rt.aliasSymbol?.name ?? rt.getSymbol()?.name;
  const rtArgs = checker.getTypeArguments(rt as ts.TypeReference);
  if (rtName === 'PagePromise') {
    const pageT = rtArgs[0];
    const itemT = rtArgs[1];
    if (pageT) {
      // Resolve the alias (e.g. ZonesV4PagePaginationArray = V4PagePaginationArray<Zone>)
      paginated = pageT.getSymbol()?.name ?? pageT.aliasSymbol?.name ?? 'page';
    }
    if (itemT) returns = typeText(itemT);
    stats.paginated++;
  } else if (rtName === 'APIPromise') {
    const inner = rtArgs[0];
    if (inner) returns = typeText(inner);
  } else {
    returns = typeText(rt);
  }

  const jsInfo = jsInfoForFile(decl.getSourceFile().fileName).get(name) ?? {};
  if (!jsInfo.http) stats.noHttp++;
  if (jsInfo.multipart) stats.multipart++;
  if (jsInfo.binary) stats.binary++;
  if (deprecated) stats.deprecated++;

  const destructive =
    jsInfo.http === 'DELETE' || /^(delete|bulkDelete|purge|destroy|remove|revoke|reset|rotate|wipe|flush)/i.test(name) || /^(delete|remove)[A-Z]/.test(name);

  const m: MethodNode = {
    name,
    cli: kebab(name),
    summary: firstSentence(doc) || undefined,
    description: doc ? (doc.length > 2000 ? doc.slice(0, 1997) + '...' : doc) : undefined,
    http: jsInfo.http,
    path: jsInfo.path,
    positionals,
    params,
    paginated,
    returns,
    deprecated: deprecated || undefined,
    deprecatedNote: deprecatedNote ? ts.displayPartsToString(deprecatedNote.text) || undefined : undefined,
    destructive: destructive || undefined,
    multipart: jsInfo.multipart || undefined,
    binary: jsInfo.binary || undefined,
  };
  methodCount++;
  return m;
}

/** Positional-like object unions are things like `string | number` masquerading — rarely happens. */
function positionalLike(members: ts.Type[]): boolean {
  return members.every((m) => m.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike));
}

function buildResource(name: string, t: ts.Type, pathParts: string[]): ResourceNode {
  const sym = t.getSymbol()!;
  const className = sym.name;
  const module = moduleOf(sym);
  const classDecl = sym.declarations?.find(ts.isClassDeclaration);
  const doc = classDecl ? cleanDoc(ts.displayPartsToString(sym.getDocumentationComment(checker))) : '';
  const node: ResourceNode = {
    name,
    cli: kebab(name),
    className,
    module,
    description: doc || undefined,
    children: [],
    methods: [],
  };
  resourceCount++;

  for (const p of t.getProperties()) {
    const pname = p.name;
    if (pname.startsWith('_') || pname === 'constructor') continue;
    const pdecl = p.valueDeclaration ?? p.declarations?.[0];
    if (!pdecl) continue;
    const pt = checker.getTypeOfSymbolAtLocation(p, pdecl);
    if (p.flags & ts.SymbolFlags.Method) {
      const m = buildMethod(pname, p, t);
      if (m) node.methods.push(m);
    } else if (p.flags & ts.SymbolFlags.Property && isResourceType(pt)) {
      node.children.push(buildResource(pname, pt, [...pathParts, pname]));
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const clientSym = checker.getSymbolAtLocation(clientClass.name!)!;
const clientType = checker.getDeclaredTypeOfSymbol(clientSym);

const root: ResourceNode = {
  name: '',
  cli: '',
  className: 'Cloudflare',
  module: 'client',
  children: [],
  methods: [],
};

for (const p of clientType.getProperties()) {
  const pdecl = p.valueDeclaration ?? p.declarations?.[0];
  if (!pdecl) continue;
  if (!(p.flags & ts.SymbolFlags.Property)) continue;
  const pt = checker.getTypeOfSymbolAtLocation(p, pdecl);
  if (!isResourceType(pt)) continue;
  root.children.push(buildResource(p.name, pt, [p.name]));
}

const manifest: Manifest = {
  sdkVersion: sdkPkg.version,
  generatedAt: new Date().toISOString(),
  root,
};

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, 'resources'), { recursive: true });

// Sanity: sibling names must not collide once normalized.
const checkCollisions = (n: ResourceNode, path: string) => {
  const seen = new Map<string, string>();
  for (const c of n.children) {
    const k = normKey(c.cli);
    if (seen.has(k)) throw new Error(`name collision at ${path}: ${seen.get(k)} vs ${c.name}`);
    seen.set(k, c.name);
    checkCollisions(c, `${path}/${c.name}`);
  }
  for (const m of n.methods) {
    const k = normKey(m.cli);
    if (seen.has(k)) throw new Error(`name collision at ${path}: ${seen.get(k)} vs method ${m.name}`);
    seen.set(k, m.name);
  }
};
checkCollisions(root, '');

// Full manifest (kept for tooling/tests), light index for startup and one detail file per top-level resource.
const json = JSON.stringify(manifest);
writeFileSync(join(OUT_DIR, 'manifest.json'), json);

const stripForIndex = (n: ResourceNode): ResourceNode => ({
  name: n.name,
  cli: n.cli,
  className: n.className,
  module: n.module,
  children: n.children.map(stripForIndex),
  methods: n.methods.map((m) => ({
    name: m.name,
    cli: m.cli,
    summary: m.summary,
    http: m.http,
    path: m.path,
    positionals: m.positionals,
    paginated: m.paginated,
    destructive: m.destructive,
    deprecated: m.deprecated,
    multipart: m.multipart,
    binary: m.binary,
    hasParams: m.params ? true : undefined,
    paramsRequired: m.params?.required || undefined,
  })),
});
const index: Manifest = { sdkVersion: manifest.sdkVersion, generatedAt: manifest.generatedAt, root: stripForIndex(root) };
writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index));
for (const c of root.children) {
  writeFileSync(join(OUT_DIR, 'resources', `${c.cli}.json`), JSON.stringify(c));
}

// Static module map (so bundlers can see every lazily imported SDK module).
const modules = new Set<string>();
const collect = (n: ResourceNode) => {
  if (n.module !== 'client') modules.add(n.module);
  n.children.forEach(collect);
};
collect(root);
const modLines = [...modules]
  .sort()
  .map((m) => `  ${JSON.stringify(m)}: () => import(${JSON.stringify('cloudflare/' + m)}),`)
  .join('\n');
writeFileSync(
  join(OUT_DIR, 'modules.ts'),
  `// Generated by scripts/gen-manifest.ts — do not edit.\n// eslint-disable\nexport const sdkModules: Record<string, () => Promise<any>> = {\n${modLines}\n};\n`,
);

console.log(
  `Generated manifest for cloudflare@${sdkPkg.version}: ${resourceCount} resources, ${methodCount} methods (${(json.length / 1024 / 1024).toFixed(2)} MB), ${modules.size} modules`,
);
console.log('stats', stats);
