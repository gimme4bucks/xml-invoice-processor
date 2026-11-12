import { isUtf8 } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import { ApiProblem } from '../../../../shared/problem-details/problem-details';

/** 1 MiB. Enforced on Content-Length up front and again while streaming (chunked uploads). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

const XML_DECLARATION_ENCODING = /^(?:\uFEFF)?<\?xml[^>]*?\sencoding\s*=\s*["']([^"']+)["']/;

/**
 * Reads a raw `application/xml` body: 415 for another media type, a Content-Encoding or anything
 * but UTF-8; 413 above the limit, without buffering more than the limit. Never parses the XML.
 */
export async function readXmlBody(
  request: IncomingMessage,
  maxBytes = MAX_DOCUMENT_BYTES,
): Promise<Buffer> {
  assertXmlContentType(request.headers['content-type']);
  const encoding = request.headers['content-encoding'];
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new ApiProblem('UNSUPPORTED_MEDIA_TYPE', 'Compressed bodies are not accepted.');
  }

  if (Number(request.headers['content-length']) > maxBytes) throw tooLarge(maxBytes);
  const chunks: Buffer[] = [];
  let size = 0;
  // destroyOnReturn: false keeps the socket alive when we stop reading early, so the client
  // still receives the 413; Node discards the rest of the upload without buffering it.
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge(maxBytes);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size);

  const declared = XML_DECLARATION_ENCODING.exec(body.subarray(0, 200).toString('latin1'))?.[1];
  if ((declared && !isUtf8Label(declared)) || !isUtf8(body)) {
    throw new ApiProblem('UNSUPPORTED_CHARSET', 'The document must be encoded as UTF-8.');
  }
  return body;
}

function assertXmlContentType(header: string | undefined): void {
  const [mediaType = '', ...parameters] = (header ?? '').split(';').map((part) => part.trim());
  if (mediaType.toLowerCase() !== 'application/xml') {
    throw new ApiProblem(
      'UNSUPPORTED_MEDIA_TYPE',
      'Send the document with Content-Type: application/xml.',
    );
  }
  for (const parameter of parameters) {
    const [name = '', value = ''] = parameter.split('=').map((part) => part.trim());
    if (name.toLowerCase() === 'charset' && !isUtf8Label(value.replaceAll('"', ''))) {
      throw new ApiProblem('UNSUPPORTED_CHARSET', 'Only charset=utf-8 is accepted.');
    }
  }
}

const isUtf8Label = (label: string): boolean => /^utf-?8$/i.test(label);

const tooLarge = (maxBytes: number) =>
  new ApiProblem(
    'PAYLOAD_TOO_LARGE',
    `The document exceeds the maximum size of ${maxBytes} bytes.`,
    {
      maxBytes,
    },
  );
