// for deno compile
// https://github.com/denoland/deno/issues/28129
export function patchFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input);

    // Check if the URL is from import.meta.resolve
    if (url.startsWith("file://")) {
      try {
        const filePath = new URL(url).pathname;
        const data = await Deno.readFile(filePath);
        const text = new TextDecoder().decode(data);

        return new Response(text, {
          status: 200,
          headers: new Headers(init?.headers),
        });
      } catch (error) {
        console.error("Error reading file:", error);
        return new Response("File not found", { status: 404 });
      }
    }

    // Use original fetch for all other URLs
    return originalFetch(input, init);
  };
}
