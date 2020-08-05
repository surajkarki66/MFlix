const MongoClient = require("mongodb").MongoClient
const NodeEnvironment = require("jest-environment-node")
module.exports = class MongoEnvironment extends NodeEnvironment {
  async setup() {
    if (!this.global.mflixClient) {
      this.global.mflixClient = await MongoClient.connect(
        process.env.MFLIX_DB_URI,
        {
          poolSize: 50,
          wtimeout: 2500,
        },
        { useNewUrlParser: true },
      )
      await super.setup()
    }
  }

  async teardown() {
    await this.global.mflixClient.close()
    await super.teardown()
  }

  runScript(script) {
    return super.runScript(script)
  }
}
