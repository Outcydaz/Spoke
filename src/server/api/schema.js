import { applyScript } from '../../lib/scripts'
import camelCaseKeys from 'camelcase-keys'
import isUrl from 'is-url'

import {
  Assignment,
  Campaign,
  CannedResponse,
  InteractionStep,
  Invite,
  Message,
  OptOut,
  Organization,
  QuestionResponse,
  UserOrganization,
  JobRequest,
  User,
  r,
  datawarehouse
} from '../models'
import {
  schema as userSchema,
  resolvers as userResolvers
} from './user'
import {
  schema as organizationSchema,
  resolvers as organizationResolvers
} from './organization'
import {
  schema as campaignSchema,
  resolvers as campaignResolvers
} from './campaign'
import {
  schema as assignmentSchema,
  resolvers as assignmentResolvers
} from './assignment'
import {
  schema as interactionStepSchema,
  resolvers as interactionStepResolvers
} from './interaction-step'
import {
  schema as questionSchema,
  resolvers as questionResolvers
} from './question'
import {
  schema as questionResponseSchema,
  resolvers as questionResponseResolvers
} from './question-response'
import {
  schema as dateSchema,
  resolvers as dateResolvers
} from './date'
import {
  schema as jsonSchema,
  resolvers as jsonResolvers
} from './json'
import {
  schema as phoneSchema,
  resolvers as phoneResolvers
} from './phone'
import {
  schema as optOutSchema,
  resolvers as optOutResolvers
} from './opt-out'
import {
  schema as messageSchema,
  resolvers as messageResolvers
} from './message'
import {
  schema as campaignContactSchema,
  resolvers as campaignContactResolvers
} from './campaign-contact'
import {
  schema as cannedResponseSchema,
  resolvers as cannedResponseResolvers
} from './canned-response'
import {
  schema as inviteSchema,
  resolvers as inviteResolvers
} from './invite'
import {
  GraphQLError,
  authRequired,
  accessRequired,
  hasRole,
  assignmentRequired,
  superAdminRequired
} from './errors'
import serviceMap from './lib/services'
import { saveNewIncomingMessage } from './lib/message-sending'
import { gzip, log } from '../../lib'
// import { isBetweenTextingHours } from '../../lib/timezones'
import { Notifications, sendUserNotification } from '../notifications'
import { uploadContacts,
         loadContactsFromDataWarehouse,
         createInteractionSteps,
         assignTexters,
         exportCampaign
       } from '../../workers/jobs'
const uuidv4 = require('uuid').v4

const JOBS_SAME_PROCESS = !!(process.env.JOBS_SAME_PROCESS || global.JOBS_SAME_PROCESS)
const JOBS_SYNC = !!(process.env.JOBS_SYNC || global.JOBS_SYNC)

const rootSchema = `
  input CampaignContactInput {
    firstName: String!
    lastName: String!
    cell: String!
    zip: String
    external_id: String
    customFields: String
  }

  input OptOutInput {
    assignmentId: String!
    cell: Phone!
    reason: String
  }

  input QuestionResponseInput {
    campaignContactId: String!
    interactionStepId: String!
    value: String!
  }

  input AnswerOptionInput {
    action: String
    value: String!
    nextInteractionStepId: String
  }

  input InteractionStepInput {
    id: String
    questionText: String
    script: String
    answerOption: String
    parentInteractionId: String
    isDeleted: Boolean
    interactionSteps: [InteractionStepInput]
  }

  input TexterInput {
    id: String
    needsMessageCount: Int
    maxContacts: Int
    contactsCount: Int
  }

  input CampaignInput {
    title: String
    description: String
    dueBy: Date
    logoImageUrl: String
    primaryColor: String
    introHtml: String
    useDynamicAssignment: Boolean
    contacts: [CampaignContactInput]
    contactSql: String
    organizationId: String
    texters: [TexterInput]
    interactionSteps: [InteractionStepInput]
    cannedResponses: [CannedResponseInput]
  }

  input MessageInput {
    text: String
    contactNumber: Phone
    assignmentId: String
    userId: String
  }

  input InviteInput {
    id: String
    is_valid: Boolean
    hash: String
    created_at: Date
  }

  input ContactMessage {
    message: MessageInput!,
    campaignContactId: String!
  }

  type Action {
    name: String
    display_name: String
    instructions: String
  }

  type RootQuery {
    currentUser: User
    organization(id:String!): Organization
    campaign(id:String!): Campaign
    inviteByHash(hash:String!): [Invite]
    contact(id:String!): CampaignContact
    assignment(id:String!): Assignment
    organizations: [Organization]
    availableActions(organizationId:String!): [Action]
  }

  type RootMutation {
    createInvite(invite:InviteInput!): Invite
    createCampaign(campaign:CampaignInput!): Campaign
    editCampaign(id:String!, campaign:CampaignInput!): Campaign
    exportCampaign(id:String!): JobRequest
    createCannedResponse(cannedResponse:CannedResponseInput!): CannedResponse
    createOrganization(name: String!, userId: String!, inviteId: String!): Organization
    joinOrganization(organizationUuid: String!): Organization
    editOrganizationRoles(organizationId: String!, userId: String!, roles: [String]): Organization
    updateTextingHours( organizationId: String!, textingHoursStart: Int!, textingHoursEnd: Int!): Organization
    updateTextingHoursEnforcement( organizationId: String!, textingHoursEnforced: Boolean!): Organization
    bulkSendMessages(assignmentId: Int!): [CampaignContact]
    sendMessage(message:MessageInput!, campaignContactId:String!): CampaignContact,
    createOptOut(optOut:OptOutInput!, campaignContactId:String!):CampaignContact,
    editCampaignContactMessageStatus(messageStatus: String!, campaignContactId:String!): CampaignContact,
    deleteQuestionResponses(interactionStepIds:[String], campaignContactId:String!): CampaignContact,
    updateQuestionResponses(questionResponses:[QuestionResponseInput], campaignContactId:String!): CampaignContact,
    startCampaign(id:String!): Campaign,
    archiveCampaign(id:String!): Campaign,
    unarchiveCampaign(id:String!): Campaign,
    sendReply(id: String!, message: String!): CampaignContact
    findNewCampaignContact(assignmentId: String!, numberContacts: Int!): CampaignContact,
    assignUserToCampaign(campaignId: String!): Campaign
    userAgreeTerms(userId: String!): User
  }

  schema {
    query: RootQuery
    mutation: RootMutation
  }
`

async function editCampaign(id, campaign, loaders, user) {
  const { title, description, dueBy, organizationId, useDynamicAssignment, logoImageUrl, introHtml, primaryColor } = campaign
  const campaignUpdates = {
    id,
    title,
    description,
    due_by: dueBy,
    organization_id: organizationId,
    use_dynamic_assignment: useDynamicAssignment,
    logo_image_url: isUrl(logoImageUrl) ? logoImageUrl : '',
    primary_color: primaryColor,
    intro_html: introHtml
  }

  Object.keys(campaignUpdates).forEach((key) => {
    if (typeof campaignUpdates[key] === 'undefined') {
      delete campaignUpdates[key]
    }
  })

  if (campaign.hasOwnProperty('contacts') && campaign.contacts) {
    const contactsToSave = campaign.contacts.map((datum) => {
      const modelData = {
        campaign_id: datum.campaignId,
        first_name: datum.firstName,
        last_name: datum.lastName,
        cell: datum.cell,
        external_id: datum.external_id,
        custom_fields: datum.customFields,
        zip: datum.zip
      }
      modelData.campaign_id = id
      return modelData
    })
    console.log('contactsToSave', contactsToSave)
    const compressedString = await gzip(JSON.stringify(contactsToSave))
    let job = await JobRequest.save({
      queue_name: `${id}:edit_campaign`,
      job_type: 'upload_contacts',
      locks_queue: true,
      assigned: JOBS_SAME_PROCESS, // can get called immediately, below
      campaign_id: id,
      // NOTE: stringifying because compressedString is a binary buffer
      payload: compressedString.toString('base64')
    })
    if (JOBS_SAME_PROCESS) {
      uploadContacts(job)
    }
  }
  if (campaign.hasOwnProperty('contactSql')
      && datawarehouse
      && user.is_superadmin) {
    let job = await JobRequest.save({
      queue_name: `${id}:edit_campaign`,
      job_type: 'upload_contacts_sql',
      locks_queue: true,
      assigned: JOBS_SAME_PROCESS, // can get called immediately, below
      campaign_id: id,
      payload: campaign.contactSql
    })
    if (JOBS_SAME_PROCESS) {
      loadContactsFromDataWarehouse(job)
    }
  }
  if (campaign.hasOwnProperty('texters')) {
    let job = await JobRequest.save({
      queue_name: `${id}:edit_campaign`,
      locks_queue: true,
      assigned: JOBS_SAME_PROCESS, // can get called immediately, below
      job_type: 'assign_texters',
      campaign_id: id,
      payload: JSON.stringify({
        id,
        texters: campaign.texters
      })
    })

    if (JOBS_SAME_PROCESS) {
      if (JOBS_SYNC) {
        await assignTexters(job)
      }
      else {
        assignTexters(job)
      }
    }

    // assign the maxContacts
    campaign.texters.forEach(async (texter) => {
      const dog = r.knex('campaign').where({ id }).select('useDynamicAssignment')
      await r.knex('assignment')
        .where({ user_id: texter.id, campaign_id: id })
        .update({ max_contacts: texter.maxContacts ? texter.maxContacts : null })
    })
  }

  if (campaign.hasOwnProperty('interactionSteps')) {
    await updateInteractionSteps(id, campaign.interactionSteps)
  }

  if (campaign.hasOwnProperty('cannedResponses')) {
    const cannedResponses = campaign.cannedResponses
    const convertedResponses = []
    for (let index = 0; index < cannedResponses.length; index++) {
      const response = cannedResponses[index]
      const newId = await Math.floor(Math.random() * 10000000)
      convertedResponses.push({
        ...response,
        campaign_id: id,
        id: newId
      })
    }

    await r.table('canned_response').getAll(id, { index: 'campaign_id' })
      .filter({ user_id: '' })
      .delete()
    await CannedResponse.save(convertedResponses)
  }

  const newCampaign = await Campaign.get(id).update(campaignUpdates)
  return newCampaign || loaders.campaign.load(id)
}

async function updateInteractionSteps(campaignId, interactionSteps, idMap = {}) {
  await interactionSteps.forEach(async (is) => {
    // map the interaction step ids for new ones
    if (idMap[is.parentInteractionId]) {
      is.parentInteractionId = idMap[is.parentInteractionId]
    }
    if (is.id.indexOf('new') !== -1) {
      const newId = await r.knex('interaction_step')
        .insert({
          parent_interaction_id: is.parentInteractionId,
          question: is.questionText,
          script: is.script,
          answer_option: is.answerOption,
          campaign_id: campaignId
        }).returning('id')
      idMap[is.id] = newId[0]
    } else {
      await r.knex('interaction_step')
        .where({ id: is.id })
        .update({
          question: is.questionText,
          script: is.script,
          answer_option: is.answerOption,
          is_deleted: is.isDeleted
        })
    }
    await updateInteractionSteps(campaignId, is.interactionSteps, idMap)
  })
}

const rootMutations = {
  RootMutation: {
    userAgreeTerms: async (_, { userId }, { user, loaders }) => {
      const currentUser = await r.table('user')
        .get(userId)
        .update({
          terms: true
        })
      return currentUser
    },

    sendReply: async (_, { id, message }, { user, loaders }) => {
      const contact = await loaders.campaignContact.load(id)

      await accessRequired(user, contact.organization_id, 'ADMIN')

      const lastMessage = await r.table('message')
        .getAll(contact.assignment_id, { index: 'assignment_id' })
        .filter({ contact_number: contact.cell })
        .limit(1)(0)
        .default(null)

      if (!lastMessage) {
        throw new GraphQLError({
          status: 400,
          message: 'Cannot fake a reply to a contact that has no existing thread yet'
        })
      }

      const userNumber = lastMessage.user_number
      const contactNumber = contact.cell
      const mockId = `mocked_${Math.random().toString(36).replace(/[^a-zA-Z1-9]+/g, '')}`
      await saveNewIncomingMessage(new Message({
        contact_number: contactNumber,
        user_number: userNumber,
        is_from_contact: true,
        text: message,
        service_response: JSON.stringify({ 'fakeMessage': true,
                                          'userId': user.id,
                                          'userFirstName': user.first_name }),
        service_id: mockId,
        assignment_id: lastMessage.assignment_id,
        service: lastMessage.service,
        send_status: 'DELIVERED'
      }))
      return loaders.campaignContact.load(id)
    },
    exportCampaign: async (_, { id }, { user, loaders }) => {
      const campaign = loaders.campaign.load(id)
      const organizationId = campaign.organization_id
      await accessRequired(user, organizationId, 'ADMIN')
      const newJob = await JobRequest.save({
        queue_name: `${id}:export`,
        job_type: 'export',
        locks_queue: false,
        assigned: JOBS_SAME_PROCESS, // can get called immediately, below
        campaign_id: id,
        payload: JSON.stringify({
          id,
          requester: user.id
        })
      })
      if (JOBS_SAME_PROCESS) {
        exportCampaign(newJob)
      }
      return newJob
    },
    editOrganizationRoles: async (_, { userId, organizationId, roles }, { user, loaders }) => {
      const currentRoles = (await r.knex('user_organization')
        .where({ organization_id: organizationId,
                user_id: userId }).select('role')).map((res) => (res.role))
      const oldRoleIsOwner = currentRoles.indexOf('OWNER') !== -1
      const newRoleIsOwner = roles.indexOf('OWNER') !== -1
      const roleRequired = (oldRoleIsOwner || newRoleIsOwner) ? 'OWNER' : 'ADMIN'
      let newOrgRoles = []

      await accessRequired(user, organizationId, roleRequired)

      currentRoles.forEach(async (curRole) => {
        if (roles.indexOf(curRole) === -1) {
          await r.table('user_organization')
            .getAll([organizationId, userId], { index: 'organization_user' })
            .filter({ role: curRole })
            .delete()
        }
      })

      newOrgRoles = roles.filter((newRole) => (currentRoles.indexOf(newRole) === -1))
        .map((newRole) => ({
          organization_id: organizationId,
          user_id: userId,
          role: newRole
        }))

      if (newOrgRoles.length) {
        await UserOrganization.save(newOrgRoles, { conflict: 'update' })
      }
      return loaders.organization.load(organizationId)
    },
    joinOrganization: async (_, { organizationUuid }, { user, loaders }) => {
      let organization
      [organization] = await r.knex('organization')
        .where('uuid', organizationUuid)
      if (organization) {
        const userOrg = await r.table('user_organization')
          .getAll(user.id, { index: 'user_id' })
          .filter({ organization_id: organization.id })
          .limit(1)(0)
          .default(null)

        if (!userOrg) {
          await UserOrganization.save({
            user_id: user.id,
            organization_id: organization.id,
            role: 'TEXTER'
          })
        }
      }
      return organization
    },
    assignUserToCampaign: async (_, { campaignId }, { user, loaders }) => {
      let campaign
      [campaign] = await r.knex('campaign')
        .where('id', campaignId)
      if (campaign) {
        const assignment = await r.table('assignment')
          .getAll(user.id, { index: 'user_id' })
          .filter({ campaign_id: campaign.id })
          .limit(1)(0)
          .default(null)
        if (!assignment) {
          await Assignment.save({
            user_id: user.id,
            campaign_id: campaign.id,
            max_contacts: (process.env.DEFAULT_MAX_CONTACTS || 1)
          })
        }
      }
      return campaign
    },
    updateTextingHours: async (_, { organizationId, textingHoursStart, textingHoursEnd }, { user }) => {
      await accessRequired(user, organizationId, 'OWNER')

      await Organization
        .get(organizationId)
        .update({
          texting_hours_start: textingHoursStart,
          texting_hours_end: textingHoursEnd
        })

      return await Organization.get(organizationId)
    },
    updateTextingHoursEnforcement: async (_, { organizationId, textingHoursEnforced }, { user }) => {
      await accessRequired(user, organizationId, 'OWNER')

      await Organization
        .get(organizationId)
        .update({
          texting_hours_enforced: textingHoursEnforced
        })

      return await Organization.get(organizationId)
    },
    createInvite: async (_, { user }) => {
      if ((user && user.is_superadmin) || !process.env.SUPPRESS_SELF_INVITE) {
        const inviteInstance = new Invite({
          is_valid: true,
          hash: uuidv4()
        })
        const newInvite = await inviteInstance.save()
        return newInvite
      }
    },
    createCampaign: async (_, { campaign }, { user, loaders }) => {
      await accessRequired(user, campaign.organizationId, 'ADMIN')
      const campaignInstance = new Campaign({
        organization_id: campaign.organizationId,
        title: campaign.title,
        description: campaign.description,
        due_by: campaign.dueBy,
        is_started: false,
        is_archived: false
      })
      const newCampaign = await campaignInstance.save()
      return editCampaign(newCampaign.id, campaign, loaders)
    },
    unarchiveCampaign: async (_, { id }, { user, loaders }) => {
      const campaign = await loaders.campaign.load(id)
      await accessRequired(user, campaign.organizationId, 'ADMIN')
      campaign.is_archived = false
      await campaign.save()
      return campaign
    },
    archiveCampaign: async (_, { id }, { user, loaders }) => {
      const campaign = await loaders.campaign.load(id)
      await accessRequired(user, campaign.organizationId, 'ADMIN')
      campaign.is_archived = true
      await campaign.save()
      return campaign
    },
    startCampaign: async (_, { id }, { user, loaders }) => {
      const campaign = await loaders.campaign.load(id)
      await accessRequired(user, campaign.organizationId, 'ADMIN')
      campaign.is_started = true
      await campaign.save()
      await sendUserNotification({
        type: Notifications.CAMPAIGN_STARTED,
        campaignId: id
      })
      return campaign
    },
    editCampaign: async (_, { id, campaign }, { user, loaders }) => {
      if (campaign.organizationId) {
        await accessRequired(user, campaign.organizationId, 'ADMIN')
      } else {
        const campaignCheck = await Campaign.get(id)
        await accessRequired(user, campaignCheck.organization_id, 'ADMIN')
      }
      return editCampaign(id, campaign, loaders, user)
    },
    createCannedResponse: async (_, { cannedResponse }, { user, loaders }) => {
      authRequired(user)

      const cannedResponseInstance = new CannedResponse({
        campaign_id: cannedResponse.campaignId,
        user_id: cannedResponse.userId,
        title: cannedResponse.title,
        text: cannedResponse.text
      }).save()
      // deletes duplicate created canned_responses
      let query = r.knex('canned_response')
        .where('text', 'in',
          r.knex('canned_response')
            .where({
              text: cannedResponse.text,
              campaign_id: cannedResponse.campaignId
            })
            .select('text')
        ).andWhere({ user_id: cannedResponse.userId })
        .del()
      await query
    },
    createOrganization: async (_, { name, userId, inviteId }, { loaders, user }) => {
      authRequired(user)
      const invite = await loaders.invite.load(inviteId)
      if (!invite || !invite.is_valid) {
        throw new GraphQLError({
          status: 400,
          message: 'That invitation is no longer valid'
        })
      }

      const newOrganization = await Organization.save({
        name,
        uuid: uuidv4()
      })
      await UserOrganization.save(
        ['OWNER', 'ADMIN', 'TEXTER'].map((role) => ({
          user_id: userId,
          organization_id: newOrganization.id,
          role
        })))
      await Invite.save({
        id: inviteId,
        is_valid: false
      }, { conflict: 'update' })

      return newOrganization
    },
    editCampaignContactMessageStatus: async(_, { messageStatus, campaignContactId }, { loaders, user }) => {
      const contact = await loaders.campaignContact.load(campaignContactId)
      await assignmentRequired(user, contact.assignment_id)
      contact.message_status = messageStatus
      return await contact.save()
    },

    findNewCampaignContact: async(_, { assignmentId, numberContacts }, { loaders, user }) => {
      /* This attempts to find a new contact for the assignment, in the case that useDynamicAssigment == true */
      const assignment = await Assignment.get(assignmentId)
      const campaign = await Campaign.get(assignment.campaign_id)
      const contactsCount = Number((await r.knex('campaign_contact').where({ assignment_id: assignmentId }).select(r.knex.raw('count(*) as count')))[0].count)

      console.log({ assignmentId, numberContacts })

      if (!campaign.use_dynamic_assignment) {
        return false
      }

      numberContacts = numberContacts || 1

      if (assignment.max_contacts && (contactsCount + numberContacts > assignment.max_contacts)) {
        numberContacts = assignment.max_contacts - contactsCount
      }

      console.log({ assignmentId, numberContacts })

      // Don't add them if they already have them
      const result = await r.knex.raw('SELECT COUNT(*) as count FROM campaign_contact WHERE assignment_id = :assignment_id AND message_status = \'needsMessage\' AND is_opted_out = false', { assignment_id: assignmentId })
      if (result.rows[0].count >= numberContacts) {
        return false
      }

      const result2 = await r.knex.raw(`UPDATE campaign_contact
        SET assignment_id = :assignment_id
        WHERE id IN (
          SELECT id
          FROM campaign_contact cc
          WHERE campaign_id = :campaign_id
          AND assignment_id IS null
          LIMIT :number_contacts
        )
        RETURNING *
        `, { assignment_id: assignmentId, campaign_id: campaign.id, number_contacts: numberContacts })

      if (result2.rowCount > 0) {
        return true
      } else {
        return false
      }
    },

    createOptOut: async(_, { optOut, campaignContactId }, { loaders, user }) => {
      const contact = await loaders.campaignContact.load(campaignContactId)
      await assignmentRequired(user, contact.assignment_id)

      const { assignmentId, cell, reason } = optOut

      const campaign = await r.table('assignment')
        .get(assignmentId)
        .eqJoin('campaign_id', r.table('campaign'))('right')
      await new OptOut({
        assignment_id: assignmentId,
        organization_id: campaign.organization_id,
        reason_code: reason,
        cell
      }).save()

      await r.knex('campaign_contact')
        .whereIn('cell', function () {
          this.select('cell').from('opt_out')
        })
        .update({
          is_opted_out: true
        })

      return loaders.campaignContact.load(campaignContactId)
    },
    bulkSendMessages: async(_, { assignmentId }, loaders) => {
      if (!process.env.ALLOW_SEND_ALL) {
        log.error('Not allowed to send all messages at once')
        throw new GraphQLError({
          status: 403,
          message: 'Not allowed to send all messages at once'
        })
      }

      const assignment = await Assignment.get(assignmentId)
      const campaign = await Campaign.get(assignment.campaign_id)
      // Assign some contacts
      await rootMutations.RootMutation.findNewCampaignContact(_, { assignmentId, numberContacts: Number(process.env.BULK_SEND_CHUNK_SIZE) - 1 }, loaders)

      const contacts = await r.knex('campaign_contact')
        .where({ message_status: 'needsMessage' })
        .where({ assignment_id: assignmentId })
        .orderByRaw('updated_at')
        .limit(process.env.BULK_SEND_CHUNK_SIZE)

      const texter = camelCaseKeys(await User.get(assignment.user_id))
      const customFields = Object.keys(JSON.parse(contacts[0].custom_fields))

      const contactMessages = await contacts.map(async (contact) => {
        const script = await campaignContactResolvers.CampaignContact.currentInteractionStepScript(contact)
        contact.customFields = contact.custom_fields
        const text = applyScript({
          contact: camelCaseKeys(contact),
          texter,
          script,
          customFields
        })
        const contactMessage = {
          contactNumber: contact.cell,
          userId: assignment.user_id,
          text,
          assignmentId
        }
        await rootMutations.RootMutation.sendMessage(_, { message: contactMessage, campaignContactId: contact.id }, loaders)
      })

      return []
    },
    sendMessage: async(_, { message, campaignContactId }, { loaders }) => {
      const contact = await loaders.campaignContact.load(campaignContactId)
      const campaign = await loaders.campaign.load(contact.campaign_id)
      if (contact.assignment_id !== parseInt(message.assignmentId) || campaign.is_archived) {
        throw new GraphQLError({
          status: 400,
          message: 'Your assignment has changed'
        })
      }
      const organization = await r.table('campaign')
        .get(contact.campaign_id)
        .eqJoin('organization_id', r.table('organization'))('right')

      const orgFeatures = JSON.parse(organization.features || '{}')

      const optOut = await r.table('opt_out')
          .getAll(contact.cell, { index: 'cell' })
          .filter({ organization_id: organization.id })
          .limit(1)(0)
          .default(null)
      if (optOut) {
        throw new GraphQLError({
          status: 400,
          message: 'Skipped sending because this contact was already opted out'
        })
      }

      // const zipData = await r.table('zip_code')
      //   .get(contact.zip)
      //   .default(null)

      // const config = {
      //   textingHoursEnforced: organization.texting_hours_enforced,
      //   textingHoursStart: organization.texting_hours_start,
      //   textingHoursEnd: organization.texting_hours_end,
      // }
      // const offsetData = zipData ? { offset: zipData.timezone_offset, hasDST: zipData.has_dst } : null
      // if (!isBetweenTextingHours(offsetData, config)) {
      //   throw new GraphQLError({
      //     status: 400,
      //     message: "Skipped sending because it's now outside texting hours for this contact"
      //   })
      // }

      const { contactNumber, text } = message

      if (text.length > (process.env.MAX_MESSAGE_LENGTH || 99999)) {
        throw new GraphQLError({
          status: 400,
          message: 'Message was longer than the limit'
        })
      }

      const replaceCurlyApostrophes = (rawText) => rawText
        .replace(/[\u2018\u2019]/g, "'")

      const messageInstance = new Message({
        text: replaceCurlyApostrophes(text),
        contact_number: contactNumber,
        user_number: '',
        assignment_id: message.assignmentId,
        send_status: (JOBS_SAME_PROCESS ? 'SENDING' : 'QUEUED'),
        service: orgFeatures.service || process.env.DEFAULT_SERVICE || '',
        is_from_contact: false,
        queued_at: new Date()
      })

      await messageInstance.save()

      contact.message_status = 'messaged'
      contact.updated_at = 'now()'
      await contact.save()

      if (JOBS_SAME_PROCESS) {
        const service = serviceMap[messageInstance.service || process.env.DEFAULT_SERVICE]
        log.info(`Sending (${service}): ${messageInstance.user_number} -> ${messageInstance.contact_number}\nMessage: ${messageInstance.text}`)
        service.sendMessage(messageInstance)
      }

      return contact
    },
    deleteQuestionResponses: async(_, { interactionStepIds, campaignContactId }, { loaders, user }) => {
      const contact = await loaders.campaignContact.load(campaignContactId)
      await assignmentRequired(user, contact.assignment_id)
      // TODO: maybe undo action_handler
      await r.table('question_response')
        .getAll(campaignContactId, { index: 'campaign_contact_id' })
        .getAll(...interactionStepIds, { index: 'interaction_step_id' })
        .delete()
      return contact
    },
    updateQuestionResponses: async(_, { questionResponses, campaignContactId }, { loaders }) => {
      const count = questionResponses.length

      for (let i = 0; i < count; i++) {
        const questionResponse = questionResponses[i]
        const { interactionStepId, value } = questionResponse
        await r.table('question_response')
          .getAll(campaignContactId, { index: 'campaign_contact_id' })
          .filter({ interaction_step_id: interactionStepId })
          .delete()
        // TODO: maybe undo action_handler if updated answer

        const qr = await new QuestionResponse({
          campaign_contact_id: campaignContactId,
          interaction_step_id: interactionStepId,
          value
        }).save()
        const interactionStepResult = await r.knex('interaction_step')
        // TODO: is this really parent_interaction_id or just interaction_id?
          .where({ 'parent_interaction_id': interactionStepId,
                  'answer_option': value })
          .whereNot('answer_actions', '')
          .whereNotNull('answer_actions')

        const interactionStepAction = (interactionStepResult.length && interactionStepResult[0].answer_actions)
        if (interactionStepAction) {
          // run interaction step handler
          try {
            const handler = require(`../action_handlers/${interactionStepAction}.js`)
            handler.processAction(qr, interactionStepResult[0], campaignContactId)
          } catch (err) {
            console.error('Handler for InteractionStep', interactionStepId,
                          'Does Not Exist:', interactionStepAction)
          }
        }
      }

      const contact = loaders.campaignContact.load(campaignContactId)
      return contact
    }
  }
}

const rootResolvers = {
  RootQuery: {
    campaign: async (_, { id }, { loaders, user }) => {
      const campaign = await loaders.campaign.load(id)
      await accessRequired(user, campaign.organization_id, 'ADMIN')
      return campaign
    },
    assignment: async (_, { id }, { loaders, user }) => {
      authRequired(user)
      const assignment = await loaders.assignment.load(id)
      const campaign = await loaders.campaign.load(assignment.campaign_id)
      const roles = {}
      const userRoles = await r.knex('user_organization').where({
        user_id: user.id,
        organization_id: campaign.organization_id
      }).select('role')
      userRoles.forEach(role => {
        roles[role['role']] = 1
      })
      if ('OWNER' in roles
        || user.is_superadmin
        || 'TEXTER' in roles && assignment.user_id == user.id) {
        return assignment
      } else {
        throw new GraphQLError({
          status: 403,
          message: 'You are not authorized to access that resource.'
        })
      }
    },
    organization: async(_, { id }, { loaders }) =>
      loaders.organization.load(id),
    inviteByHash: async (_, { hash }, { loaders, user }) => {
      authRequired(user)
      return r.table('invite').filter({ hash })
    },
    currentUser: async(_, { id }, { user }) => user,
    contact: async(_, { id }, { loaders, user }) => {
      authRequired(user)
      const contact = await loaders.campaignContact.load(id)
      const campaign = await loaders.campaign.load(contact.campaign_id)
      const roles = {}
      const userRoles = await r.knex('user_organization').where({
        user_id: user.id,
        organization_id: campaign.organization_id
      }).select('role')
      userRoles.forEach(role => {
        roles[role['role']] = 1
      })
      if ('OWNER' in roles || user.is_superadmin) {
        return contact
      } else if ('TEXTER' in roles) {
        const assignment = await loaders.assignment.load(contact.assignment_id)
        return contact
      } else {
        console.error('NOT Authorized: contact', user, roles)
        throw new GraphQLError({
          status: 403,
          message: 'You are not authorized to access that resource.'
        })
      }
    },
    organizations: async(_, { id }, { user }) => {
      await superAdminRequired(user)
      return r.table('organization')
    },
    availableActions: (_, { organizationId }, { user }) => {
      if (!process.env.ACTION_HANDLERS) {
        return []
      }
      const allHandlers = process.env.ACTION_HANDLERS.split(',')

      const availableHandlers = allHandlers.map(handler => {
        return { 'name': handler,
                'handler': require(`../action_handlers/${handler}.js`)
               }
      }).filter(async (h) => (h && (await h.handler.available(organizationId))))

      const availableHandlerObjects = availableHandlers.map(handler => {
        return {
          'name': handler.name,
          'display_name': handler.handler.displayName(),
          'instructions': handler.handler.instructions()
        }
      })
      return availableHandlerObjects
    }
  }
}

export const schema = [
  rootSchema,
  userSchema,
  organizationSchema,
  dateSchema,
  jsonSchema,
  phoneSchema,
  campaignSchema,
  assignmentSchema,
  interactionStepSchema,
  optOutSchema,
  messageSchema,
  campaignContactSchema,
  cannedResponseSchema,
  questionResponseSchema,
  questionSchema,
  inviteSchema
]

export const resolvers = {
  ...rootResolvers,
  ...userResolvers,
  ...organizationResolvers,
  ...campaignResolvers,
  ...assignmentResolvers,
  ...interactionStepResolvers,
  ...optOutResolvers,
  ...messageResolvers,
  ...campaignContactResolvers,
  ...cannedResponseResolvers,
  ...questionResponseResolvers,
  ...inviteResolvers,
  ...dateResolvers,
  ...jsonResolvers,
  ...phoneResolvers,
  ...questionResolvers,
  ...rootMutations
}
