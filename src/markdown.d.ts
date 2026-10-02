// A workflow's content, imported as text beside it, as `SDK_DECLARATIONS` declares it.
declare module "*.md" {
  const text: string;
  export default text;
}

// The release key, imported as text.
declare module "*.pub" {
  const text: string;
  export default text;
}
