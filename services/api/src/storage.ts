import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

// forcePathStyle for MinIO; a no-op against real S3. In the cluster the
// credentials block is dropped entirely and the SDK's default chain picks up
// the IRSA role (stage 03), so this file does not change between environments.
export const s3 = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
});

// A second client, used only for signing. Its endpoint is the one a browser
// can reach. Everything else — the actual API calls this service makes — goes
// through the client above.
const signer = config.S3_PUBLIC_ENDPOINT
  ? new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_PUBLIC_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
    })
  : s3;

/**
 * A URL the browser can PUT one object to, directly.
 *
 * Uploads bypass this service entirely. That is the whole reason for
 * presigning: proxying a 25 MB file through the API would tie up a Node
 * process for the duration of the upload, make request timeouts a function of
 * the user's upstream bandwidth, and put memory pressure on a pod that is
 * supposed to be answering queries.
 *
 * ContentLength is signed into the URL, so a client cannot present a URL
 * issued for a small file and upload a large one.
 */
export function presignUpload(key: string, contentType: string, size: number) {
  return getSignedUrl(
    signer,
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: size,
    }),
    { expiresIn: config.PRESIGN_TTL_SECONDS },
  );
}

export function presignDownload(key: string) {
  return getSignedUrl(signer, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), {
    expiresIn: config.PRESIGN_TTL_SECONDS,
  });
}
