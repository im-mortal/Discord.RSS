const Discord = require('discord.js')
const listeners = require('./util/listeners.js')
const initialize = require('./util/initialization.js')
const config = require('./config.json')
const ScheduleManager = require('./util/ScheduleManager.js')
const storage = require('./util/storage.js')
const log = require('./util/logger.js')
const currentGuilds = storage.currentGuilds
const configRes = require('./util/configCheck.js').check(config)
const connectDb = require('./rss/db/connect.js')
const DISABLED_EVENTS = ['TYPING_START', 'MESSAGE_DELETE', 'MESSAGE_UPDATE', 'PRESENCE_UPDATE', 'VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE', 'USER_NOTE_UPDATE', 'CHANNEL_PINS_UPDATE']

if (configRes && configRes.fatal) throw new Error(configRes.message)
else if (configRes) log.general.info(configRes.message)

let restartTime = config.feedSettings.refreshTimeMinutes * 60000 / 4 * 10
restartTime = restartTime < 60000 ? Math.ceil(restartTime * 4) : Math.ceil(restartTime) // Try to make sure it's never below a minute
const restartTimeDisp = (restartTime / 1000 / 60).toFixed(2)

let scheduleManager
let bot

// Function to handle login/relogin automatically
let loginAttempts = 0
const maxAttempts = 5

bot = new Discord.Client({disabledEvents: DISABLED_EVENTS})
const SHARD_ID = bot.shard ? 'SH ' + bot.shard.id + ' ' : ''

function login (firstStartup) {
  if (!firstStartup) bot = new Discord.Client({disabledEvents: DISABLED_EVENTS})

  bot.login(config.botSettings.token)
  .catch(err => {
    if (loginAttempts++ >= maxAttempts) {
      log.general.error(`${SHARD_ID}Discord.RSS failed to login after ${maxAttempts} attempts. Terminating.`)
      if (bot.shard) bot.shard.send('kill')
    }
    log.general.error(`${SHARD_ID}Discord.RSS failed to login (${err}) on attempt #${loginAttempts}, retrying in ${restartTimeDisp} minutes...`)
    setTimeout(login, restartTime)
  })

  bot.once('ready', function () {
    loginAttempts = 0
    bot.user.setPresence({ game: { name: (config.botSettings.defaultGame && typeof config.botSettings.defaultGame === 'string') ? config.botSettings.defaultGame : null, type: 0 } })
    log.general.info(`${SHARD_ID}Discord.RSS has logged in as "${bot.user.username}" (ID ${bot.user.id}), processing set to ${config.advanced.processorMethod}`)
    if (firstStartup) {
      if (config.botSettings.enableCommands !== false) listeners.enableCommands(bot)
      connectDb((err) => {
        if (err) throw err
        initialize(bot, finishInit)
      })
    } else scheduleManager = new ScheduleManager(bot)
  })
}

function finishInit (guildsInfo) {
  storage.initialized = 1
  if (bot.shard) {
    process.send({ type: 'initComplete', guilds: guildsInfo })
    process.send({ type: 'mergeLinkList', linkList: storage.linkList })
  }
  scheduleManager = new ScheduleManager(bot)
  listeners.createManagers(bot)
}

if (!bot.shard || (bot.shard && bot.shard.count === 1)) login(true)
else {
  process.on('message', message => {
    switch (message.type) {
      case 'startInit':
        if (bot.shard.id === message.shardId) login(true)
        break

      case 'finishedInit':
        storage.initialized = 2
        break

      case 'runSchedule':
        if (bot.shard.id === message.shardId) scheduleManager.run(message.refreshTime)
        break

      case 'updateGuild':
        if (!bot.guilds.has(message.guildRss.id)) return
        currentGuilds.set(message.guildRss.id, message.guildRss)
        break

      case 'deleteGuild':
        if (!bot.guilds.has(message.guildId)) return
        currentGuilds.delete(message.guildId)
        break

      case 'updateFailedLinks':
        storage.failedLinks = message.failedLinks
        break

      case 'updateBlacklists':
        storage.blacklistGuilds = message.blacklistGuilds
        storage.blacklistUsers = message.blacklistUsers
        break

      case 'updateLinkList':
        storage.linkList = message.linkList
        break

      case 'mergeLinkList':
        message.linkList.forEach(link => {
          if (!storage.linkList.includes(link)) storage.linkList.push(link)
        })
        break

      case 'updateVIPs':
        storage.webhookServers = message.webhookServers
        storage.cookieServers = message.cookieServers
        storage.limitOverrides = message.limitOverrides
        break

      case 'dbRestoreSend':
        const channel = bot.channels.get(message.channelID)
        if (!channel) return
        const channelMsg = channel.messages.get(message.messageID)
        if (channelMsg) channelMsg.edit('Database restore complete! Stopping bot process for manual reboot.').then(m => bot.shard.send('kill'))
        else channel.send('Database restore complete! Stopping bot process for manual reboot.').then(m => bot.shard.send('kill'))
        break
    }
  })
}

process.on('uncaughtException', err => {
  console.log(`${SHARD_ID}Fatal Error\n`, err)
  if (bot.shard) {
    bot.shard.broadcastEval('process.exit()')
    bot.shard.send('kill')
  }
  process.exit()
})
