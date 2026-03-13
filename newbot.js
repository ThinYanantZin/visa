const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    PermissionsBitField
} = require("discord.js");
require("dotenv").config();
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v10");

const fs = require("fs");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

let leaderboardMessage = null;

const MAX_EVENTS = 5;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

let events = {};
let visa = {};

if (fs.existsSync("./events.json"))
    events = JSON.parse(fs.readFileSync("./events.json"));

if (fs.existsSync("./visa.json"))
    visa = JSON.parse(fs.readFileSync("./visa.json"));

function save() {
    fs.writeFileSync("./events.json", JSON.stringify(events, null, 2));
    fs.writeFileSync("./visa.json", JSON.stringify(visa, null, 2));
}

async function buildVisaLeaderboard() {

    const sorted = Object.entries(visa)
        .sort((a, b) => b[1].expiry - a[1].expiry)
        .slice(0, 10);

    if (!sorted.length) return "No VISA holders.";

    let text = "🏆 **VISA Leaderboard**\n\n";

    let rank = 1;

    for (const [userId, data] of sorted) {

        const expiry = data.expiry;
        const vacation = data.vacation;

        const timestamp = Math.floor(expiry / 1000);

        let username = "Unknown";

        try {
            const user = await client.users.fetch(userId);
            username = user.username;
        } catch { }

        const vacationText = vacation ? " 🌴 Vacation" : "";

        text += `**#${rank} ${username}**\n⏳ Expires <t:${timestamp}:R>${vacationText}\n\n`;

        rank++;
    }

    const embed = new EmbedBuilder()
        .setTitle("🛂 Borderland VISA System")
        .setDescription(text)
        .setColor(0x00bfff)
        .setTimestamp();

    return { embeds: [embed] };
}

async function updateVisaLeaderboard() {

    if (!leaderboardMessage) return;

    try {

        const data = await buildVisaLeaderboard();

        await leaderboardMessage.edit(data);

    } catch (err) {

        console.log("Leaderboard update failed:", err.message);

    }

}

client.once("clientReady", () => {
    console.log(`Bot online as ${client.user.tag}`);
});

setInterval(updateVisaLeaderboard, 60000);

setInterval(async () => {

    const now = Date.now();
    const guild = client.guilds.cache.get(GUILD_ID);

    if (!guild) return;

    for (const userId in visa) {

        let data = visa[userId];

        // convert old format (timestamp → object)
        if (typeof data === "number") {
            data = visa[userId] = {
                expiry: data,
                vacation: false,
                vacationStart: null
            };
        }

        // pause visa consumption
        if (data.vacation) continue;

        if (data.expiry < now) {

            try {

                const member = await guild.members.fetch(userId).catch(() => null);

                if (member) await member.kick("VISA expired");

            } catch (err) {
                console.log("Kick failed:", err.message);
            }

            delete visa[userId];

        }

    }

    save();

}, 1 * 60 * 1000);

client.on("interactionCreate", async interaction => {

    if (interaction.isChatInputCommand()) {

        if (interaction.commandName === "eventcreate") {

            const name = interaction.options.getString("name");
            const time = interaction.options.getInteger("time");
            const duration = time * 60 * 1000;
            const endTimestamp = Math.floor((Date.now() + duration) / 1000);
            const activeEvents = Object.values(events).filter(e => e.status !== "ended");

            if (activeEvents.length >= MAX_EVENTS)
                return interaction.reply({ content: "Maximum events reached.", flags: 64 });

            const id = Date.now().toString();

            events[id] = {
                id,
                name,
                creator: interaction.user.id,
                participants: [],
                status: "signup",
                messageId: null,
                joinDeadline: Date.now() + duration,
                endTimestamp
            };

            const joinBtn = new ButtonBuilder()
                .setCustomId(`join_${id}`)
                .setLabel("Join")
                .setStyle(ButtonStyle.Success);

            const leaveBtn = new ButtonBuilder()
                .setCustomId(`leave_${id}`)
                .setLabel("Leave")
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(joinBtn, leaveBtn);

            const embed = new EmbedBuilder()
                .setTitle(`🎮 ${name}`)
                .setDescription(
                    `Event ID: **${id}**

Signup closes: <t:${endTimestamp}:R>
Participants: 0`
                )
                .setColor("Green");

            const msg = await interaction.reply({
                embeds: [embed],
                components: [row],
                fetchReply: true
            });

            events[id].messageId = msg.id;

            save();

            setTimeout(async () => {

                if (!events[id]) return;

                const event = events[id];
                const guild = interaction.guild;

                event.status = "running";

                // format channel name
                const channelName = name
                    .toLowerCase()
                    .replace(/[^a-z0-9\s-]/g, "")
                    .replace(/\s+/g, "-");

                // create role
                const role = await guild.roles.create({
                    name: name
                });

                // create channel
                const channel = await guild.channels.create({
                    name: channelName,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone,
                            deny: [PermissionsBitField.Flags.ViewChannel]
                        },
                        {
                            id: role.id,
                            allow: [PermissionsBitField.Flags.ViewChannel]
                        }
                    ]
                });

                // give role to participants
                for (const userId of event.participants) {

                    const member = guild.members.cache.get(userId);

                    if (member) await member.roles.add(role);

                }

                event.role = role.id;
                event.channel = channel.id;

                save();

                interaction.followUp(
                    `Signup closed. Event **${name}** has started in <#${channel.id}>`
                );

            }, duration);
        }

        if (interaction.commandName === "eventlist") {

            const active = Object.values(events).filter(e => e.status !== "ended");

            if (!active.length)
                return interaction.reply("No active events.");

            let description = "";

            for (const e of active) {

                let statusIcon = "🟡";

                if (e.status === "running") statusIcon = "🟢";
                if (e.status === "signup") statusIcon = "🟡";

                description +=
                    `${statusIcon} **${e.name}**
🆔 \`${e.id}\`
👥 ${e.participants.length} players
Status: **${e.status}**

`;

            }

            const embed = new EmbedBuilder()
                .setTitle("🎮 Active Events")
                .setDescription(description)
                .setColor(0x2ecc71)
                .setFooter({ text: `${active.length} active event(s)` })
                .setTimestamp();

            interaction.reply({ embeds: [embed] });

        }

        if (interaction.commandName === "eventend") {

            const id = interaction.options.getString("id");
            const giveVisa = interaction.options.getString("givevisa");
            const days = interaction.options.getInteger("days") || 0;

            const event = events[id];

            if (!event)
                return interaction.reply({ content: "Event not found", flags: 64 });

            const guild = interaction.guild;

            if (giveVisa === "yes") {

                if (days <= 0)
                    return interaction.reply({ content: "You must enter VISA days.", flags: 64 });

                console.log("Participants receiving VISA:", event.participants);

                for (const userId of event.participants) {

                    const now = Date.now();
                    const add = days * 86400000;

                    // convert old format (timestamp → object)
                    if (visa[userId] && typeof visa[userId] === "number") {
                        visa[userId] = {
                            expiry: visa[userId],
                            vacation: false,
                            vacationStart: null
                        };
                    }

                    // create new visa user
                    if (!visa[userId]) {
                        visa[userId] = {
                            expiry: now + add,
                            vacation: false,
                            vacationStart: null
                        };
                        continue;
                    }

                    const userVisa = visa[userId];

                    // ensure missing fields exist
                    if (userVisa.vacation === undefined)
                        userVisa.vacation = false;

                    if (userVisa.vacationStart === undefined)
                        userVisa.vacationStart = null;

                    // if visa still valid extend it
                    if (userVisa.expiry > now)
                        userVisa.expiry += add;
                    else
                        userVisa.expiry = now + add;

                }

            }

            const role = guild.roles.cache.get(event.role);
            const channel = guild.channels.cache.get(event.channel);

            if (role) role.delete();
            if (channel) channel.delete();

            event.status = "ended";

            save();

            if (giveVisa === "yes") {
                await updateVisaLeaderboard();
                interaction.reply(
                    `Event ended. ${event.participants.length} players received ${days} VISA days.`
                );
            }
            else
                interaction.reply(`Event ended. No VISA awarded.`);

        }

        if (interaction.commandName === "eventadd") {

            const id = interaction.options.getString("id");
            const user = interaction.options.getUser("user");

            const event = events[id];

            if (!event)
                return interaction.reply({ content: "Event not found.", flags: 64 });

            if (event.participants.includes(user.id))
                return interaction.reply({ content: "User already in event.", flags: 64 });

            event.participants.push(user.id);

            // If event already started, giv    e role
            if (event.status === "running" && event.role) {

                try {

                    const member = await interaction.guild.members.fetch(user.id);
                    const role = interaction.guild.roles.cache.get(event.role);

                    if (member && role)
                        await member.roles.add(role);

                } catch (err) {

                    console.log("Role add failed:", err.message);

                }
            }

            save();

            interaction.reply(`${user.username} added to event.`);

        }

        if (interaction.commandName === "visa") {

            const user = interaction.options.getUser("user") || interaction.user;

            const data = visa[user.id];

            if (!data)
                return interaction.reply(`${user.username} has no VISA.`);

            const expiry = data.expiry;
            const vacation = data.vacation;

            if (expiry <= Date.now())
                return interaction.reply(`${user.username}'s VISA has expired.`);

            const timestamp = Math.floor(expiry / 1000);

            const embed = new EmbedBuilder()
                .setTitle("🛂 VISA Status")
                .setDescription(
                    `**User:** ${user.username}

⏳ Expires: <t:${timestamp}:R>
📅 Exact: <t:${timestamp}:F>

🌴 Vacation: ${vacation ? "Active" : "Off"}`
                )
                .setColor(0x3498db)
                .setThumbnail(user.displayAvatarURL())
                .setTimestamp();

            interaction.reply({ embeds: [embed] });

        }

        if (interaction.commandName === "visaboard") {

            const data = await buildVisaLeaderboard();

            leaderboardMessage = await interaction.reply({
                ...data,
                fetchReply: true
            });

        }

        if (interaction.commandName === "checkvisa") {

            const userId = interaction.user.id;

            if (!visa[userId])
                return interaction.reply("❌ You currently have no VISA.");

            const expiry = visa[userId].expiry;

            if (expiry <= Date.now())
                return interaction.reply("❌ Your VISA has expired.");

            const timestamp = Math.floor(expiry / 1000);

            const embed = new EmbedBuilder()
                .setTitle("🛂 VISA Status")
                .setDescription(
                    `Your VISA expires **<t:${timestamp}:R>**

📅 Exact time:
<t:${timestamp}:F>`
                )
                .setColor("Blue")
                .setFooter({ text: interaction.user.username })
                .setTimestamp();

            interaction.reply({ embeds: [embed] });

        }

    }

    if (interaction.commandName === "vacation") {

        const gmRole = interaction.guild.roles.cache.find(r => r.name === "Game Master");

        if (!gmRole || !interaction.member.roles.cache.has(gmRole.id))
            return interaction.reply({ content: "❌ Only Game Masters can use this command.", flags: 64 });

        const user = interaction.options.getUser("user");
        const userId = user.id;

        if (!visa[userId])
            return interaction.reply({ content: `${user.username} does not have a VISA.`, flags: 64 });

        // convert old format
        if (typeof visa[userId] === "number") {
            visa[userId] = {
                expiry: visa[userId],
                vacation: false,
                vacationStart: null
            };
        }

        const userVisa = visa[userId];

        if (!userVisa.vacation) {

            userVisa.vacation = true;
            userVisa.vacationStart = Date.now();

            interaction.reply(`🌴 Vacation mode **ENABLED** for ${user.username}.`);

        } else {

            const pausedTime = Date.now() - userVisa.vacationStart;

            userVisa.expiry += pausedTime;
            userVisa.vacation = false;
            userVisa.vacationStart = null;

            interaction.reply(`🏠 Vacation mode **DISABLED** for ${user.username}.`);

        }

        save();

    }

    if (interaction.isButton()) {

        const [action, id] = interaction.customId.split("_");

        const event = events[id];

        if (!event)
            return interaction.reply({ content: "Event not found.", flags: 64 });

        if (action === "join") {

            if (!event.participants.includes(interaction.user.id))
                event.participants.push(interaction.user.id);

            await interaction.reply({ content: "Joined event!", flags: 64 });

        }

        if (action === "leave") {

            event.participants = event.participants.filter(u => u !== interaction.user.id);

            await interaction.reply({ content: "Left event.", flags: 64 });

        }

        try {

            const msg = await interaction.channel.messages.fetch(event.messageId);

            const embed = EmbedBuilder.from(msg.embeds[0]);

            embed.setDescription(
                `Event ID: **${id}**

Signup closes: <t:${event.endTimestamp}:R>
Participants: ${event.participants.length}`
            );

            await msg.edit({ embeds: [embed] });

        } catch (err) {

            console.log("Message update failed:", err.message);

        }

        save();

    }

});

const commands = [

    {
        name: "eventcreate",
        description: "Create event",
        options: [
            {
                name: "name",
                type: 3,
                description: "Event name",
                required: true
            },
            {
                name: "time",
                type: 4,
                description: "Signup time in minutes",
                required: true
            }
        ]
    },

    {
        name: "eventlist",
        description: "List active events"
    },

    {
        name: "eventend",
        description: "End event",
        options: [
            {
                name: "id",
                type: 3,
                description: "Event ID",
                required: true
            },
            {
                name: "givevisa",
                type: 3,
                description: "Give visa? yes/no",
                required: false,
                choices: [
                    { name: "Yes", value: "yes" },
                    { name: "No", value: "no" }
                ]
            },
            {
                name: "days",
                type: 4,
                description: "Visa days",
                required: false
            }
        ]
    },

    {
        name: "eventadd",
        description: "Add late player",
        options: [
            {
                name: "id",
                type: 3,
                description: "Event ID",
                required: true
            },
            {
                name: "user",
                type: 6,
                description: "User",
                required: true
            }
        ]
    },

    {
        name: "visa",
        description: "Check VISA",
        options: [
            {
                name: "user",
                type: 6,
                description: "User",
                required: false
            }
        ]
    },

    {
        name: "visaboard",
        description: "VISA leaderboard"
    },

    {
        name: "checkvisa",
        description: "Check your VISA status"
    },

    {
        name: "vacation",
        description: "Toggle vacation mode for a player",
        options: [
            {
                name: "user",
                type: 6,
                description: "User to toggle vacation mode",
                required: true
            }
        ]
    }

];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {

    await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
    );

    console.log("Slash commands registered");

})();

client.login(TOKEN);