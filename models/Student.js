// Student register stores only rollNo, name and PRN.
class Student {
  static normalize(input = {}) {
    return {
      rollNo: String(input.rollNo || '').trim().toUpperCase().slice(0, 40),
      name: String(input.name || '').trim().slice(0, 100),
      prn: String(input.prn || '').trim().toUpperCase().slice(0, 40),
    };
  }
  static isValid(student) {
    return Boolean(student.rollNo && student.name && student.prn);
  }
}
module.exports = Student;
