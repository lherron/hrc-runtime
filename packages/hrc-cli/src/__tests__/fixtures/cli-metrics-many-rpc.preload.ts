import { HrcClient } from 'hrc-sdk'

const originalListRuntimes = HrcClient.prototype.listRuntimes

HrcClient.prototype.listRuntimes = async function (
  this: HrcClient,
  ...args: Parameters<HrcClient['listRuntimes']>
) {
  let result: Awaited<ReturnType<HrcClient['listRuntimes']>> = []
  for (let index = 0; index < 64; index += 1) {
    result = await originalListRuntimes.call(this, args[0])
  }
  return result
}
