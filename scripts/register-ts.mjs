// Lets `node --test` import this repo's extensionless TypeScript specifiers.
import { register } from 'node:module';

const source = `
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.(?:[cm]?[jt]s|json|mjs|cjs|node)$/.test(specifier)) {
    return nextResolve(specifier + '.ts', context);
  }
  return nextResolve(specifier, context);
}
`;

await register(`data:text/javascript,${encodeURIComponent(source)}`, {
  parentURL: import.meta.url,
});
