// Attendance document shape stored in MongoDB's attendance collection.
// Unique compound index: one attendance mark per PRN per election.
module.exports = {
  collectionName: 'attendance',
  uniqueKey: ['electionId', 'prn'],
  fields: ['electionId', 'electionName', 'prn', 'studentName', 'classYear', 'present', 'markedAt', 'markedBy'],
};
