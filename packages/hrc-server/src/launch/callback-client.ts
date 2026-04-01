import { request } from 'node:http'

export function postCallback(
  socketPath: string,
  endpoint: string,
  payload: object
): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)

    const req = request(
      {
        socketPath,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        // Drain response
        res.resume()
        res.on('end', () => {
          resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300)
        })
      }
    )

    req.on('error', () => {
      resolve(false)
    })

    req.write(body)
    req.end()
  })
}
