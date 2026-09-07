import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "./config.js";

// forcePathStyle because MinIO serves buckets at /bucket/key rather than as a
// subdomain. Against real S3 this is a no-op, so the same client works in both
// places — which is the point of using MinIO locally rather than mocking S3.
//
// The static credentials here are local-only. In the cluster this client gets
// its credentials from IRSA (stage 03) and the whole credentials block is
// omitted, because the SDK's default chain finds the pod identity by itself.
export const s3 = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
});

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
